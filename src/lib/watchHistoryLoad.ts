import "server-only";
import { serviceDb, userDb } from "./supabase";
import { mapWithConcurrency } from "./adapters/http";
import { readAssetPrices } from "./adapters/assetPrices";
import { evmCheckable, readEvmChain, readSolana, type SourceRead } from "./adapters/watchActivitySources";
import { identifyLegs } from "./watchActivityCheck";
import { WEBHOOK_NETWORKS } from "./alchemyWebhookTx";
import { CASH_KEYS, DOLLAR_KEYS, type TxActivity } from "./watchActivity";
import { assetStates } from "./watchDiff";
import { extendCoverage, HISTORY_KEEP_DAYS, mergeHistoryLegs, planHistoryReads, type HistoryDays, type TradeHistory } from "./watchHistory";
import { backfillMovements, readTimes } from "./watchBackfill";
import { createTtlCache } from "./ttlCache";
import { parseNumeric } from "./valuation";
import type { WatchSnapshot } from "./watchSnapshot";

// Activity backfill (owner 2026-09-29): an influencer's addresses — EVM
// and Solana alike — read back 7 or 30 days, and the Activity list filled
// with the lines the morning read would have written for the days before
// each address was first read (watchBackfill.ts), marked "from
// transactions". The trades read are kept on the watched address
// (`trade_history`, 30 days), so a later backfill — or anyone watching the
// same wallet — reads only what's missing, and the morning read adds the
// day's legs (watchRefresh.ts). EVM: Alchemy's transfers, up to
// HISTORY_PAGES × 100 per direction per chain (120 CU a call). Solana:
// Helius's parsed transactions, 100 credits per 100 — so only the owner can
// backfill a Solana address (the trading record, a year of PnL from Solana
// Tracker, is a different thing and stays as it is).

export interface BackfillResult {
  days: HistoryDays;
  /** Lines written to the Activity list, per address. */
  written: { address: string; chain: string; movements: number }[];
  /** Chain reads made (0: everything came from stored history). */
  reads: number;
  failed: string[];
  partial: string[];
  /** Solana addresses skipped (only the owner backfills those: Helius credits). */
  skippedSolana: number;
  /** Already watched longer than the window: the real reads cover it. */
  coveredByReads: number;
}

const inFlight = createTtlCache<BackfillResult>(10_000, 100);
/** Chains always read on an EVM address: the live networks and Base, besides the snapshot's. */
const ALWAYS = [...Object.keys(WEBHOOK_NETWORKS), "base"];
const DAY_MS = 86_400_000;
/** Pages of 100 per direction per chain: a split-order trader (VirtualBacon,
 * 461 transactions in a week on Robinhood Chain) overflows the day check's 5. */
const HISTORY_PAGES = 20;
/** Solana pages of 100 transactions (100 Helius credits each): a busy meme
 * wallet makes ~200 a day, so 30 days can pass this — the rest is named. */
const SOLANA_PAGES = 30;

type Row = { chain: string; address: string; snapshot: WatchSnapshot | null; last_refresh_at: string | null; created_at: string; trade_history: TradeHistory | null; tx_activity: TxActivity | null };

export async function backfillActivity(influencerId: string, days: HistoryDays, isOwner: boolean): Promise<{ result: BackfillResult; fetchedAtMs: number }> {
  // The user's client proves they watch this influencer (RLS).
  const db = await userDb();
  const { data: inf, error } = await db.from("watch_influencers").select("id, watch_influencer_addresses(chain, address)").eq("id", influencerId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!inf) throw new Error("Not found");
  const addresses = (inf as unknown as { watch_influencer_addresses: { chain: string; address: string }[] }).watch_influencer_addresses;
  // Concurrent presses share one run; storage does the rest.
  const r = await inFlight.get(`${influencerId}|${days}|${isOwner}`, () => run(addresses, days, isOwner));
  return { result: r.value, fetchedAtMs: r.fetchedAtMs };
}

async function run(addresses: { chain: string; address: string }[], days: HistoryDays, isOwner: boolean): Promise<BackfillResult> {
  const now = Date.now();
  const startMs = now - days * DAY_MS;
  const keepFromMs = now - HISTORY_KEEP_DAYS * DAY_MS;
  const wanted = addresses.filter((a) => a.chain === "ETH" || (a.chain === "SOL" && isOwner));
  const result: BackfillResult = { days, written: [], reads: 0, failed: [], partial: [], skippedSolana: addresses.filter((a) => a.chain === "SOL" && !isOwner).length, coveredByReads: 0 };
  if (wanted.length === 0) return result;

  const svc = serviceDb();
  const { data, error } = await svc
    .from("watched_addresses")
    .select("chain, address, snapshot, last_refresh_at, created_at, trade_history, tx_activity")
    .in("chain", [...new Set(wanted.map((a) => a.chain))])
    .in("address", wanted.map((a) => a.address));
  if (error) throw new Error(error.message);
  // Only what the window reaches before the first read: after it, the real
  // reads' lines are the activity.
  const rows = (data as Row[]).filter((r) => r.snapshot && r.last_refresh_at);
  const toFill = rows.filter((r) => Date.parse(r.created_at) > startMs);
  result.coveredByReads = rows.length - toFill.length;

  // What isn't stored yet, per address × chain (watchHistory.ts), a few at a time.
  const tasks = toFill.flatMap((r) => {
    const chains = r.chain === "SOL" ? ["solana"] : [...new Set([...r.snapshot!.rows.map((x) => x.chain).filter((c): c is string => !!c), ...ALWAYS])].filter(evmCheckable);
    return planHistoryReads(r.trade_history?.coverage ?? {}, chains, startMs, now).map((read) => ({ row: r, read }));
  });
  result.reads = tasks.length;
  const readAt = new Date(now).toISOString();
  const reads = await mapWithConcurrency(tasks, 3, async ({ row, read }) => {
    try {
      let res: SourceRead;
      if (read.chain === "solana") {
        res = await readSolana(row.address, read.kind === "newer" ? read.fromBlock : null, startMs, SOLANA_PAGES, read.kind === "older" ? read.toBlock : null);
      } else {
        res = await readEvmChain(row.address, read.chain, read.kind === "newer" ? read.fromBlock : null, startMs, HISTORY_PAGES, read.kind === "older" ? read.toBlock : null);
      }
      if (res.partial) result.partial.push(`${read.chain} (${row.address.slice(0, 6)}…)`);
      // A capped read only covers back to its oldest transaction.
      const readFrom = res.partial && res.oldestAt ? res.oldestAt : new Date(startMs).toISOString();
      return { changes: res.changes, coverage: { kind: read.kind, readFrom, readTo: readAt, oldestBlock: res.oldestBlock ?? null, newestBlock: res.cursor } };
    } catch (e) {
      result.failed.push(`${read.chain} (${row.address.slice(0, 6)}…): ${(e as Error).message}`);
      return null;
    }
  });
  if (tasks.length > 0 && result.failed.length === tasks.length) throw new Error(`No chain could be read: ${result.failed[0]}`); // not cached

  // Daily closes: the cash coin's to size swaps, every coin's for the lines.
  const closeRows = await svc.from("asset_price_daily").select("price_key, day, usd").gte("day", new Date(startMs).toISOString().slice(0, 10));
  if (closeRows.error) throw new Error(closeRows.error.message);
  const close = new Map((closeRows.data as { price_key: string; day: string; usd: number | string }[]).map((c) => [`${c.price_key}|${c.day}`, parseNumeric(c.usd)]));
  // A stablecoin is $1 on a day with no stored close (USDG: none stored).
  const closeOn = (key: string, day: string) => close.get(`${key}|${day}`) ?? (DOLLAR_KEYS.has(key) ? 1 : null);
  const cashCloseOn = (key: string, day: string) => (CASH_KEYS.has(key) ? closeOn(key, day) : null);

  for (const r of toFill) {
    const mine = tasks.map((t, i) => ({ t, res: reads[i] })).filter((x) => x.t.row === r);
    const changes = mine.flatMap((x) => x.res?.changes ?? []);
    const added = changes.length > 0 ? await identifyLegs(changes, r.snapshot!, readAssetPrices, readAt, "check", undefined, cashCloseOn) : [];
    // Kept for the next backfill and every other watcher: the new trades, and
    // how far each chain has now been read (a failed read claims nothing).
    const coverage = { ...(r.trade_history?.coverage ?? {}) };
    for (const x of mine) if (x.res) coverage[x.t.read.chain] = extendCoverage(coverage[x.t.read.chain], x.res.coverage, keepFromMs);
    const history: TradeHistory = { legs: mergeHistoryLegs(r.trade_history?.legs ?? [], added, keepFromMs), coverage };
    if (mine.length > 0) {
      const { error: saveError } = await svc.from("watched_addresses").update({ trade_history: history }).eq("chain", r.chain).eq("address", r.address);
      if (saveError) throw new Error(`History not saved: ${saveError.message}`);
    }

    // The lines for each day from the window's start to the first read.
    const firstReadMs = Date.parse(r.created_at);
    const times = [...readTimes(startMs, firstReadMs - 1), firstReadMs];
    const legs = mergeHistoryLegs(history.legs, r.tx_activity?.legs ?? [], startMs);
    const qtyNow = new Map([...assetStates(r.snapshot!)].map(([k, s]) => [k, s.qty]));
    const lines = backfillMovements(legs, qtyNow, Date.parse(r.last_refresh_at!), times, closeOn);
    // Replaced, not added to: a later backfill with more history rewrites them.
    const { error: clearError } = await svc.from("watched_movements").delete().eq("chain", r.chain).eq("address", r.address).eq("source", "transactions");
    if (clearError) throw new Error(clearError.message);
    if (lines.length > 0) {
      const { error: writeError } = await svc.from("watched_movements").upsert(
        lines.map((m) => ({
          chain: r.chain,
          address: r.address,
          snapshot_at: m.snapshotAt,
          asset_key: m.assetKey,
          kind: m.kind,
          position_type: "token",
          ticker: m.ticker,
          price_key: m.priceKey,
          qty_before: m.qtyBefore,
          qty_after: m.qtyAfter,
          price_usd: m.priceUsd,
          usd_delta: m.usdDelta,
          contract: m.contract,
          contract_chain: m.contractChain,
          source: "transactions",
        })),
        { onConflict: "chain,address,snapshot_at,asset_key,kind", ignoreDuplicates: true },
      );
      if (writeError) throw new Error(`Activity not written: ${writeError.message}`);
    }
    result.written.push({ address: r.address, chain: r.chain, movements: lines.length });
  }
  return result;
}

import "server-only";
import { serviceDb, userDb } from "./supabase";
import { mapWithConcurrency } from "./adapters/http";
import { readAssetPrices } from "./adapters/assetPrices";
import { evmCheckable, readEvmChain } from "./adapters/watchActivitySources";
import { identifyLegs } from "./watchActivityCheck";
import { WEBHOOK_NETWORKS } from "./alchemyWebhookTx";
import { CASH_KEYS, coinDays, type ActivityLeg, type TxActivity } from "./watchActivity";
import { assetStates } from "./watchDiff";
import { extendCoverage, HISTORY_KEEP_DAYS, mergeHistoryLegs, planHistoryReads, windowBase, type HistoryDays, type TradeHistory } from "./watchHistory";
import { createTtlCache } from "./ttlCache";
import { parseNumeric } from "./valuation";
import type { WatchSnapshot } from "./watchSnapshot";
import type { WatchCoinDay } from "./watchQuery";

// Recent trades (watchHistory.ts): an influencer's EVM addresses read back
// 7 or 30 days through Alchemy's transfers — the same reads, reduction and
// per-coin view as Refresh activity, over a longer window. What's read is
// stored on the watched address (`trade_history`, 30 days): a later press,
// or anyone watching the same wallet, reads only what's missing — newer
// transfers since the last read, older days for a longer window — and the
// morning read adds the day's legs (watchRefresh.ts). Swaps are sized at the
// cash coin's close on the trade's day (asset_price_daily), else today's
// price, and the result says how many. A read is up to HISTORY_PAGES × 100
// transfers per direction per chain (120 CU a call). Solana addresses are
// the trading record's (Solana Tracker), not read here.

export interface RecentTrades {
  days: HistoryDays;
  from: string;
  coins: WatchCoinDay[];
  /** Chains read per address, and any that failed or hit the page cap. */
  chains: number;
  failed: string[];
  partial: string[];
  /** Swaps sized at today's price because the day's close wasn't stored. */
  sizedToday: number;
  solanaAddresses: number;
}

const inFlight = createTtlCache<RecentTrades>(10_000, 100);
/** Chains always read: the live networks and Base, besides the snapshot's. */
const ALWAYS = [...Object.keys(WEBHOOK_NETWORKS), "base"];
const DAY_MS = 86_400_000;
/** Pages of 100 per direction per chain: a split-order trader (VirtualBacon,
 * 461 transactions in a week on Robinhood Chain) overflows the day check's 5. */
const HISTORY_PAGES = 20;

export async function loadRecentTrades(influencerId: string, days: HistoryDays): Promise<{ trades: RecentTrades; fetchedAtMs: number }> {
  // The user's client proves they watch this influencer (RLS).
  const db = await userDb();
  const { data: inf, error } = await db.from("watch_influencers").select("id, name, watch_influencer_addresses(chain, address)").eq("id", influencerId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!inf) throw new Error("Not found");
  const influencer = inf as unknown as { id: string; name: string; watch_influencer_addresses: { chain: string; address: string }[] };
  // Concurrent presses share one read; storage does the rest.
  const r = await inFlight.get(`${influencerId}|${days}`, () => read(influencer, days));
  return { trades: r.value, fetchedAtMs: r.fetchedAtMs };
}

async function read(influencer: { id: string; name: string; watch_influencer_addresses: { chain: string; address: string }[] }, days: HistoryDays): Promise<RecentTrades> {
  const now = Date.now();
  const startMs = now - days * DAY_MS;
  const from = new Date(startMs).toISOString();
  const evm = influencer.watch_influencer_addresses.filter((a) => a.chain === "ETH").map((a) => a.address);
  const solanaAddresses = influencer.watch_influencer_addresses.filter((a) => a.chain === "SOL").length;
  const empty: RecentTrades = { days, from, coins: [], chains: 0, failed: [], partial: [], sizedToday: 0, solanaAddresses };
  if (evm.length === 0) return empty;

  const svc = serviceDb();
  const { data, error } = await svc.from("watched_addresses").select("address, snapshot, last_refresh_at, trade_history").eq("chain", "ETH").in("address", evm);
  if (error) throw new Error(error.message);
  const rows = (data as { address: string; snapshot: WatchSnapshot | null; last_refresh_at: string | null; trade_history: TradeHistory | null }[]).filter((r) => r.snapshot && r.last_refresh_at);
  const keepFromMs = now - HISTORY_KEEP_DAYS * DAY_MS;

  // Only what isn't stored yet (watchHistory.ts planHistoryReads): per
  // address × chain, a few at a time (Alchemy's per-second cap).
  const tasks = rows.flatMap((r) => {
    const chains = [...new Set([...r.snapshot!.rows.map((x) => x.chain).filter((c): c is string => !!c), ...ALWAYS])].filter(evmCheckable);
    return planHistoryReads(r.trade_history?.coverage ?? {}, chains, startMs, now).map((read) => ({ address: r.address, read }));
  });
  const failed: string[] = [];
  const partial: string[] = [];
  const readAt = new Date(now).toISOString();
  const reads = await mapWithConcurrency(tasks, 3, async (t) => {
    try {
      const { read } = t;
      const res = await readEvmChain(t.address, read.chain, read.kind === "newer" ? read.fromBlock : null, startMs, HISTORY_PAGES, read.kind === "older" ? read.toBlock : null);
      if (res.partial) partial.push(`${read.chain} (${t.address.slice(0, 6)}…)`);
      // A capped read only covers back to its oldest transfer.
      const readFrom = res.partial && res.oldestAt ? res.oldestAt : new Date(startMs).toISOString();
      return { changes: res.changes, coverage: { kind: read.kind, readFrom, readTo: readAt, oldestBlock: res.oldestBlock ?? null, newestBlock: res.cursor } };
    } catch (e) {
      failed.push(`${t.read.chain} (${t.address.slice(0, 6)}…): ${(e as Error).message}`);
      return null;
    }
  });
  if (tasks.length > 0 && failed.length === tasks.length) throw new Error(`No chain could be read: ${failed[0]}`); // not cached

  // The cash coins' daily closes in the window: one request.
  const { data: closes, error: closeError } = await svc.from("asset_price_daily").select("price_key, day, usd").in("price_key", [...CASH_KEYS]).gte("day", from.slice(0, 10));
  if (closeError) throw new Error(closeError.message);
  const close = new Map((closes as { price_key: string; day: string; usd: number | string }[]).map((c) => [`${c.price_key}|${c.day}`, parseNumeric(c.usd)]));
  const today = new Date(now).toISOString().slice(0, 10);
  const closeOn = (key: string, day: string) => close.get(`${key}|${day}`) ?? null;

  const checkedAt = new Date(now).toISOString();
  const activities: TxActivity[] = [];
  for (const r of rows) {
    const mine = tasks.map((t, i) => ({ t, res: reads[i] })).filter((x) => x.t.address === r.address);
    const changes = mine.flatMap((x) => x.res?.changes ?? []);
    const added = changes.length > 0 ? await identifyLegs(changes, r.snapshot!, readAssetPrices, checkedAt, "check", undefined, closeOn) : [];
    // Saved for the next press and every other watcher: the new trades, and
    // how far each chain has now been read (a failed read claims nothing).
    const coverage = { ...(r.trade_history?.coverage ?? {}) };
    for (const x of mine) if (x.res) coverage[x.t.read.chain] = extendCoverage(coverage[x.t.read.chain], x.res.coverage, keepFromMs);
    const history: TradeHistory = { legs: mergeHistoryLegs(r.trade_history?.legs ?? [], added, keepFromMs), coverage };
    if (mine.length > 0) {
      const { error: saveError } = await svc.from("watched_addresses").update({ trade_history: history }).eq("chain", "ETH").eq("address", r.address);
      if (saveError) throw new Error(`Recent trades not saved: ${saveError.message}`);
    }
    const legs = history.legs.filter((l) => Date.parse(l.at) >= startMs);
    activities.push({ boundary: from, legs, base: windowBase(assetStates(r.snapshot!), legs, Date.parse(r.last_refresh_at!), startMs) });
  }
  // Trades before today sized at today's price: a cash coin with no stored
  // close that day, or a coin-for-coin swap sized at stored prices.
  const atToday = (l: ActivityLeg) =>
    l.kind === "swap" && l.at.slice(0, 10) !== today && (l.sizedBy === "stored" || (!!l.priceKey && CASH_KEYS.has(l.priceKey) && closeOn(l.priceKey, l.at.slice(0, 10)) === null));
  const sizedToday = new Set(activities.flatMap((a) => a.legs.filter(atToday).map((l) => l.txId))).size;
  const coins = coinDays(activities, new Set(evm));
  const keys = [...new Set(coins.map((c) => c.priceKey).filter((k): k is string => !!k))];
  const { data: priced } = keys.length > 0 ? await svc.from("asset_prices").select("price_key, usd, updated_at").in("price_key", keys) : { data: [] };
  const priceNow = new Map(((priced ?? []) as { price_key: string; usd: number | string | null; updated_at: string | null }[]).map((p) => [p.price_key, p]));
  return {
    ...empty,
    coins: coins
      .map((c) => ({ ...c, influencerId: influencer.id, influencerName: influencer.name, nowUsd: c.priceKey ? parseNumeric(priceNow.get(c.priceKey)?.usd ?? null) : null, nowAt: (c.priceKey && priceNow.get(c.priceKey)?.updated_at) || null }))
      .sort((x, y) => y.lastAt.localeCompare(x.lastAt)),
    chains: tasks.length,
    failed,
    partial: partial.length > 0 ? [...partial, `over ${HISTORY_PAGES * 100} transfers each way`] : [],
    sizedToday,
  };
}

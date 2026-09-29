import "server-only";
import { serviceDb } from "./supabase";
import { fetchAddressHoldings } from "./lookup";
import { withPriceKeys } from "./adapters/assetKeys";
import { ensureAssetPrices } from "./adapters/assetPrices";
import { mapWithConcurrency } from "./adapters/http";
import { carryForward, keptNote } from "./carryForward";
import { getAssetStatsMap, getPriceMap, type AssetStats } from "./queries";
import { aggregate, valueHolding } from "./valuation";
import { JOB_STALE_MS, SCHEDULED_STATUS } from "./jobStatus";
import { buildSnapshot, previousContracts, snapshotRowToAdapter, type SnapshotRow, type WatchSnapshot } from "./watchSnapshot";
import { assetOf, assetStates, contractKeys, diffSnapshots, type AssetState } from "./watchDiff";
import { positionChanges, type OpenPosition } from "./watchPositions";
import { trimToBoundary, type ActivityLeg } from "./watchActivity";
import { HISTORY_KEEP_DAYS, mergeHistoryLegs, type TradeHistory } from "./watchHistory";
import { rewriteActivity } from "./txActivityStore";
import { markKeyFor } from "./perpPositions";
import { parseNumeric, type PriceMap } from "./valuation";
import type { Chain } from "./types";

// Wallet Watch's one refresh path (docs/wallet-watch/PLAN.md): every write of
// a watched address's snapshot goes through refreshWatchedAddress, whether a
// user pressed Refresh or (phase 2) the daily cron ran. It reads the address
// like a wallet sync does — the previous snapshot's tokens passed in, and a
// source that failed keeps its previous rows (carryForward.ts) — so a failed
// read never looks like the address sold something.
//
// Shared tables, written with the service role: one row per address however
// many users watch it. Supabase requests per refresh: 1 read, 1 claim, 1
// write, plus the price-key lookups and pricing a wallet sync also makes.

export interface WatchedKey {
  chain: string;
  address: string;
}

/** How long until an address is due again for the daily cron. Short on
 * purpose: the cron runs once a day, so this only keeps it from re-reading an
 * address someone refreshed in the last few hours. 20 h (the first value)
 * made an evening Refresh skip the next morning's run entirely
 * (2026-09-27: every address read at 03:41–04:55 UTC was due only after the
 * 08:00 run). */
const NEXT_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Addresses read at once: each EVM read already fans out across chains. */
const CONCURRENCY = 2;

/** Creates the shared row for an address the first time anyone watches it. */
export async function ensureWatchedAddress(key: WatchedKey): Promise<void> {
  const { error } = await serviceDb().from("watched_addresses").upsert(key, { onConflict: "chain,address", ignoreDuplicates: true });
  if (error) throw new Error(`Failed to add the address: ${error.message}`);
}

/** Claims the addresses not already being refreshed (compare-and-set, like a
 * wallet sync); returns the ones claimed. The cron claims with
 * SCHEDULED_STATUS so no open page polls for a read nobody asked for. */
export async function claimWatchedAddresses(keys: readonly WatchedKey[], marker: "syncing" | typeof SCHEDULED_STATUS = "syncing"): Promise<WatchedKey[]> {
  const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();
  const startedAt = new Date().toISOString();
  const claimed: WatchedKey[] = [];
  for (const k of keys) {
    const { data, error } = await serviceDb()
      .from("watched_addresses")
      .update({ refresh_status: marker, refresh_started_at: startedAt })
      .eq("chain", k.chain)
      .eq("address", k.address)
      .or(`refresh_status.not.in.(syncing,${SCHEDULED_STATUS}),refresh_status.is.null,refresh_started_at.lt.${staleBefore}`)
      .select("chain");
    if (error) throw new Error(`Failed to start refresh: ${error.message}`);
    if (data && data.length > 0) claimed.push(k);
  }
  return claimed;
}

const unitAmount = (raw: string, decimals: number | null) => (decimals === null ? null : Number(raw) / 10 ** decimals);

/** A coin that held its dollar peg: within 2% of $1 now, and moved under 2%
 * over 7 days and 3% over 30 (asset_prices; no stablecoin list is stored). */
function isCashLike(stats: AssetStats | undefined): boolean {
  if (!stats || stats.usd === null || Math.abs(stats.usd - 1) > 0.02) return false;
  return stats.change7d !== null && Math.abs(stats.change7d) <= 2 && stats.change30d !== null && Math.abs(stats.change30d) <= 3;
}

/** An asset's per-unit dollar price at this read, or null when it can't be
 * sized (unpriced, or illiquid at this size — liquidity.ts). Perps use the
 * venue's mark, else the entry; prediction shares their value per share. */
function priceFor(asset: AssetState, rows: readonly SnapshotRow[], prices: PriceMap): number | null {
  const row = rows.find((r) => assetOf(r)?.key === asset.key);
  if (asset.type === "perp") {
    const mark = row ? markKeyFor({ chain: row.chain ?? null, ticker: row.ticker, contract: row.contract ?? null }) : null;
    return (mark ? parseNumeric(prices[mark]) : null) ?? row?.position_entry_price ?? null;
  }
  if (asset.type === "prediction") return row?.usd_override != null && row.qty ? row.usd_override / row.qty : null;
  if (!asset.priceKey || asset.qty <= 0) return asset.priceKey ? parseNumeric(prices[asset.priceKey]) : null;
  const v = valueHolding({ ticker: asset.ticker, qty: asset.qty, usd_override: null, source: "auto", price_key: asset.priceKey }, prices);
  return v.kind === "priced" ? v.usd / asset.qty : null;
}

/** Reads one address and saves its snapshot, the movements since the last
 * read, its positions and the day's value. Never throws: a failure is
 * recorded in its status and the previous snapshot stays (so nothing moves).
 * `stats` (read once per batch) decides which coins are cash-like. */
export async function refreshWatchedAddress({ chain, address }: WatchedKey, stats: ReadonlyMap<string, AssetStats> = new Map()): Promise<void> {
  const db = serviceDb();
  const done = (fields: Record<string, unknown>) => db.from("watched_addresses").update(fields).eq("chain", chain).eq("address", address);
  try {
    // The activity check's day starts here, not when the snapshot is saved:
    // a trade during a minutes-long read is in neither the balances nor the
    // check otherwise (docs/wallet-watch/PLAN.md, phase 4 review item 3).
    const readStartedAt = new Date().toISOString();
    const { data: row, error } = await db.from("watched_addresses").select("snapshot").eq("chain", chain).eq("address", address).single();
    if (error) throw new Error(error.message);
    const previous = (row.snapshot as WatchSnapshot | null) ?? null;

    const result = await fetchAddressHoldings(chain as Chain, address, previousContracts(previous));
    const fresh = await withPriceKeys(result.holdings, "auto");
    const previousRows = (previous?.rows ?? []).map(snapshotRowToAdapter);
    const carried = carryForward(fresh, previousRows, result.keep ?? []);
    const keptRows = carried.holdings.slice(fresh.length) as SnapshotRow[];

    // Price what was read first: the snapshot keeps rows by current value.
    await ensureAssetPrices(fresh.map((r) => r.price_key), "watch").catch(() => {});
    const prices = await getPriceMap();
    const valueOf = (r: { ticker: string; qty: number | null; usd_override: number | null; price_key?: string | null }) => {
      const v = valueHolding({ ticker: r.ticker, qty: r.qty, usd_override: r.usd_override, source: "auto", price_key: r.price_key ?? null }, prices);
      return v.kind === "priced" ? v.usd : null;
    };
    const snapshot = buildSnapshot(
      fresh,
      keptRows,
      [
        ...(result.discovery?.unrecognized ?? []).map((u) => ({ chain: u.chain, contract: u.contract, symbol: u.symbol, amount: unitAmount(u.balanceRaw, u.decimals) })),
        // Solana: held but under a floor today — kept if stored before, so it isn't a "sale".
        ...(result.heldNotShown ?? []),
      ],
      valueOf,
      previous,
    );
    snapshot.readStartedAt = readStartedAt;
    const valued = aggregate(
      snapshot.rows.map((r) => ({ ticker: r.ticker, qty: r.qty ?? null, usd_override: r.usd_override ?? null, source: "auto" as const, price_key: r.price_key ?? null })),
      prices,
    );
    const status = [...result.warnings, keptNote(carried.kept)].filter(Boolean);
    const statusText = status.length === 0 ? "ok" : `partial — ${status.join("; ")}`;
    const now = new Date();
    const snapshotAt = now.toISOString();

    // What changed since the last read (watchDiff.ts), and each position's
    // life (watchPositions.ts).
    const priceOf = (a: AssetState) => priceFor(a, [...snapshot.rows, ...(previous?.rows ?? [])], prices);
    const movements = diffSnapshots(previous, snapshot, priceOf);
    const { data: openRows, error: openError } = await db
      .from("watched_positions")
      .select("chain, address, asset_key, opened_at, position_type, ticker, price_key, held_at_start, entry_price, entry_qty, last_qty, last_seen_at, closed_at, exit_price")
      .eq("chain", chain)
      .eq("address", address);
    if (openError) throw new Error(openError.message);
    const positions = openRows as ({ asset_key: string; opened_at: string; closed_at: string | null } & Record<string, unknown>)[];
    const open: OpenPosition[] = positions.filter((p) => !p.closed_at).map((p) => ({ assetKey: p.asset_key, openedAt: p.opened_at }));
    const changes = positionChanges({
      // Addresses read before positions were tracked start from here too.
      firstRead: previous === null || positions.length === 0,
      states: assetStates(snapshot, contractKeys(previous)),
      movements,
      open,
      now: snapshotAt,
      priceOf,
    });

    const { error: saveError } = await done({
      snapshot,
      total_usd: valued.total,
      unpriced_count: valued.unpricedCount,
      last_refresh_at: snapshotAt,
      last_refresh_status: statusText,
      refresh_status: statusText,
      next_refresh_at: new Date(now.getTime() + NEXT_REFRESH_MS).toISOString(),
    });
    if (saveError) throw new Error(saveError.message);
    // The activity legs from before this read are in the snapshot now — trimmed
    // under the compare-and-set, so a live delivery landing meanwhile isn't lost.
    let dropped: ActivityLeg[] = [];
    await rewriteActivity(chain, address, (prev) => {
      dropped = (prev?.legs ?? []).filter((l) => Date.parse(l.at) < Date.parse(readStartedAt));
      return trimToBoundary(prev, readStartedAt);
    });
    // …and kept in the address's stored trade history (Recent trades,
    // watchHistory.ts) instead of discarded: history builds up at no extra
    // read. EVM only — Recent trades reads EVM wallets.
    if (chain === "ETH" && dropped.length > 0) await keepInHistory(address, dropped);

    const cashUsd = snapshot.rows.reduce((sum, r) => {
      if (!r.price_key || !isCashLike(stats.get(r.price_key))) return sum;
      const v = valueHolding({ ticker: r.ticker, qty: r.qty ?? null, usd_override: null, source: "auto", price_key: r.price_key }, prices);
      return v.kind === "priced" ? sum + v.usd : sum;
    }, 0);
    // Closed and still-held positions in one request (not one per position:
    // each request is a log line, CLAUDE.md §5): their stored rows with the
    // changed fields, upserted on the key. A close wins over a touch.
    const stored = new Map(positions.map((p) => [`${p.asset_key}|${p.opened_at}`, p]));
    const updated = new Map<string, Record<string, unknown>>();
    for (const t of changes.touches) {
      const row = stored.get(`${t.assetKey}|${t.openedAt}`);
      if (row) updated.set(`${t.assetKey}|${t.openedAt}`, { ...row, last_qty: t.qty, last_seen_at: snapshotAt });
    }
    for (const c of changes.closes) {
      const row = stored.get(`${c.assetKey}|${c.openedAt}`);
      if (row) updated.set(`${c.assetKey}|${c.openedAt}`, { ...row, closed_at: snapshotAt, exit_price: c.exitPrice, last_qty: 0, last_seen_at: snapshotAt });
    }
    const updates = [...updated.values()];
    // Best-effort after the snapshot is saved: a failure here is named in the
    // status but never loses the read.
    const writes = await Promise.all([
      db.from("watched_address_daily").upsert(
        { chain, address, day: snapshotAt.slice(0, 10), total_usd: valued.total, cash_usd: cashUsd, unpriced_count: valued.unpricedCount },
        { onConflict: "chain,address,day" },
      ),
      movements.length === 0
        ? Promise.resolve({ error: null })
        : db.from("watched_movements").upsert(
            movements.map((m) => ({
              chain,
              address,
              snapshot_at: snapshotAt,
              asset_key: m.assetKey,
              kind: m.kind,
              position_type: m.positionType,
              ticker: m.ticker,
              label: m.label,
              price_key: m.priceKey,
              side: m.side,
              qty_before: m.qtyBefore,
              qty_after: m.qtyAfter,
              price_usd: m.priceUsd,
              usd_delta: m.usdDelta,
              wallet_total_usd_after: valued.total,
              contract: m.contract,
              contract_chain: m.contractChain,
            })),
            { onConflict: "chain,address,snapshot_at,asset_key,kind", ignoreDuplicates: true },
          ),
      changes.inserts.length === 0
        ? Promise.resolve({ error: null })
        : db.from("watched_positions").upsert(
            changes.inserts.map((p) => ({
              chain,
              address,
              asset_key: p.assetKey,
              opened_at: p.openedAt,
              position_type: p.positionType,
              ticker: p.ticker,
              price_key: p.priceKey,
              held_at_start: p.heldAtStart,
              entry_price: p.entryPrice,
              entry_qty: p.entryQty,
              last_qty: p.entryQty,
              last_seen_at: snapshotAt,
            })),
            { onConflict: "chain,address,asset_key,opened_at", ignoreDuplicates: true },
          ),
      updates.length === 0 ? Promise.resolve({ error: null }) : db.from("watched_positions").upsert(updates, { onConflict: "chain,address,asset_key,opened_at" }),
    ]);
    const failed = writes.map((w) => w.error?.message).filter(Boolean);
    if (failed.length > 0) {
      const text = `${statusText === "ok" ? "partial" : statusText} — history not saved: ${failed[0]}`;
      await done({ last_refresh_status: text, refresh_status: text });
    }
  } catch (e) {
    const statusText = `error: ${(e as Error).message}`;
    await done({ last_refresh_status: statusText, refresh_status: statusText });
  }
}

export async function refreshWatchedAddresses(keys: readonly WatchedKey[]): Promise<void> {
  const stats = await getAssetStatsMap().catch(() => new Map<string, AssetStats>());
  await mapWithConcurrency([...keys], CONCURRENCY, (k) => refreshWatchedAddress(k, stats));
}

/** The day's legs, once the morning read covers them, added to the stored
 * trade history (two requests; the coverage isn't changed — these came from
 * webhooks and checks, not a full read of the window). */
async function keepInHistory(address: string, legs: readonly ActivityLeg[]): Promise<void> {
  const db = serviceDb();
  const { data } = await db.from("watched_addresses").select("trade_history").eq("chain", "ETH").eq("address", address).single();
  const prev = (data?.trade_history as TradeHistory | null) ?? { legs: [], coverage: {} };
  const next: TradeHistory = { ...prev, legs: mergeHistoryLegs(prev.legs, legs, Date.now() - HISTORY_KEEP_DAYS * 86_400_000) };
  const { error } = await db.from("watched_addresses").update({ trade_history: next }).eq("chain", "ETH").eq("address", address);
  if (error) console.error(`Trade history not kept for ${address}: ${error.message}`);
}

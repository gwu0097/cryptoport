import "server-only";
import { serviceDb } from "./supabase";
import { withPriceKeys } from "./adapters/assetKeys";
import { ensureAssetPrices } from "./adapters/assetPrices";
import { ALCHEMY_HOSTS } from "./adapters/alchemy";
import { mapWithConcurrency } from "./adapters/http";
import { evmCheckable, INTERNAL_TRANSFER_CHAINS, MAX_PAGES, readBitcoin, readEvmChain, readSolana, type SourceRead } from "./adapters/watchActivitySources";
import { appendLegs, CASH_KEYS, toLegs, type ActivityBase, type ActivityLeg, type LegIdentity, type RawChange, type TxActivity } from "./watchActivity";
import { assetStates, contractKeys } from "./watchDiff";
import { isInProgressStatus } from "./jobStatus";
import { parseNumeric } from "./valuation";
import type { AssetStats } from "./queries";
import type { WatchSnapshot } from "./watchSnapshot";

// The activity check (docs/wallet-watch/PLAN.md, phase 4): on demand, each
// address's transactions since its last check, saved on watched_addresses
// (tx_activity, appended; tx_cursor per source) until the next full read.
// Shared per address: a check any watcher runs is reused by the others for
// CHECK_REUSE_MS.

/** An address checked this recently isn't read again (Helius credits: a
 * busy wallet is up to MAX_PAGES calls). */
export const CHECK_REUSE_MS = 15 * 60 * 1000;
const CONCURRENCY = 4;

/** Coins whose price sizes the other side of a swap (watchActivity.ts). */
const VALUE_KEYS = CASH_KEYS;
/** Served EVM chains whose source can't see a router's native payout. */
const NO_NATIVE_LEGS: ReadonlySet<string> = new Set(Object.keys(ALCHEMY_HOSTS).filter((c) => !INTERNAL_TRANSFER_CHAINS.has(c)));
/** Snapshot chains that are venues, not chains — the morning read covers them. */
const VENUES = new Set(["hyperliquid", "lighter", "aster", "polymarket", "solana-defi"]);

export interface CheckRow {
  chain: string;
  address: string;
  snapshot: WatchSnapshot | null;
  tx_activity: TxActivity | null;
  tx_cursor: Record<string, string> | null;
  tx_checked_at: string | null;
  last_refresh_at: string | null;
  refresh_status: string | null;
  live: boolean | null;
  live_since: string | null;
}

export interface CheckOutcome {
  chain: string;
  address: string;
  ok: boolean;
  /** Plain words: "3 new transactions", "reused — checked 4m ago", an error. */
  status: string;
}

/** Claims the addresses that can be checked now (compare-and-set on
 * tx_checked_at) and says why the others aren't. Two requests. */
export async function claimActivityCheck(keys: readonly { chain: string; address: string }[], nowMs: number): Promise<{ claimed: CheckRow[]; skipped: CheckOutcome[] }> {
  const db = serviceDb();
  const wanted = new Set(keys.map((k) => `${k.chain}|${k.address}`));
  const { data, error } = await db
    .from("watched_addresses")
    .select("chain, address, snapshot, tx_activity, tx_cursor, tx_checked_at, last_refresh_at, refresh_status, live, live_since")
    .in("address", [...new Set(keys.map((k) => k.address))]);
  if (error) throw new Error(`Failed to load addresses: ${error.message}`);
  const rows = (data as CheckRow[]).filter((r) => wanted.has(`${r.chain}|${r.address}`));
  const skipped: CheckOutcome[] = [];
  const candidates: CheckRow[] = [];
  for (const r of rows) {
    const checkedAgo = r.tx_checked_at ? nowMs - Date.parse(r.tx_checked_at) : Infinity;
    if (!r.snapshot || !r.last_refresh_at) skipped.push({ chain: r.chain, address: r.address, ok: false, status: "not read yet" });
    else if (isInProgressStatus(r.refresh_status)) skipped.push({ chain: r.chain, address: r.address, ok: true, status: "being read now" });
    else if (checkedAgo < CHECK_REUSE_MS) skipped.push({ chain: r.chain, address: r.address, ok: true, status: `reused — checked ${Math.max(1, Math.round(checkedAgo / 60000))}m ago` });
    else candidates.push(r);
  }
  if (candidates.length === 0) return { claimed: [], skipped };
  const cutoff = new Date(nowMs - CHECK_REUSE_MS).toISOString();
  const { data: won, error: claimError } = await db
    .from("watched_addresses")
    .update({ tx_checked_at: new Date(nowMs).toISOString() })
    .in("address", candidates.map((r) => r.address))
    .or(`tx_checked_at.is.null,tx_checked_at.lt.${cutoff}`)
    .select("chain, address");
  if (claimError) throw new Error(`Failed to start the check: ${claimError.message}`);
  const got = new Set((won as { chain: string; address: string }[]).map((w) => `${w.chain}|${w.address}`));
  for (const r of candidates) if (!got.has(`${r.chain}|${r.address}`)) skipped.push({ chain: r.chain, address: r.address, ok: true, status: "reused — just checked" });
  return { claimed: candidates.filter((r) => got.has(`${r.chain}|${r.address}`)), skipped };
}

/** Reads one claimed address from its cursor and saves what it found. Never
 * throws: a failure keeps its cursor and says so. */
export async function checkAddress(row: CheckRow, stats: ReadonlyMap<string, AssetStats>, nowMs: number): Promise<CheckOutcome> {
  const db = serviceDb();
  const checkedAt = new Date(nowMs).toISOString();
  const snapshot = row.snapshot!;
  const boundary = snapshot.readStartedAt ?? row.last_refresh_at!;
  const boundaryMs = Date.parse(boundary);
  const cursor = { ...(row.tx_cursor ?? {}) };
  const outcome = (ok: boolean, status: string): CheckOutcome => ({ chain: row.chain, address: row.address, ok, status });
  try {
    // Which sources to read: the chains the morning snapshot holds.
    const sources: { key: string; read: () => Promise<SourceRead> }[] = [];
    const notChecked: string[] = [];
    if (row.chain === "SOL") sources.push({ key: "sol", read: () => readSolana(row.address, cursor.sol ?? null, boundaryMs) });
    else if (row.chain === "BTC") sources.push({ key: "btc", read: () => readBitcoin(row.address, boundaryMs) });
    else if (row.chain === "ETH") {
      for (const c of new Set(snapshot.rows.map((r) => r.chain).filter((c): c is string => !!c))) {
        if (evmCheckable(c)) sources.push({ key: c, read: () => readEvmChain(row.address, c, cursor[c] ?? null, boundaryMs) });
        else notChecked.push(c);
      }
    } else return outcome(false, `not checked — ${row.chain} has no transaction source`);

    const reads = await Promise.allSettled(sources.map((s) => s.read()));
    const changes: RawChange[] = [];
    const failed: string[] = [];
    let partial = false;
    reads.forEach((r, i) => {
      if (r.status === "rejected") {
        failed.push(`${sources[i].key}: ${(r.reason as Error).message}`);
        return;
      }
      changes.push(...r.value.changes);
      partial ||= r.value.partial;
      if (r.value.cursor) cursor[sources[i].key] = r.value.cursor;
    });
    // Only a source that answered moves its cursor (saved with its legs below).

    const legs = await identifyLegs(changes, snapshot, pricesFromStats(stats), checkedAt, "check");
    const states = assetStates(snapshot);
    const base: Record<string, ActivityBase> = {};
    for (const l of legs) {
      const s = states.get(l.assetKey);
      base[l.assetKey] = { qty: s?.qty ?? 0, kept: s?.kept ?? false };
    }
    const activity = appendLegs(row.tx_activity, boundary, legs, base);
    const added = activity.legs.length - (row.tx_activity?.boundary === boundary ? row.tx_activity.legs.length : 0);
    // Live wallets (phase 5): swaps since it went live that the webhook hadn't saved.
    const liveSince = row.live && row.live_since ? Date.parse(row.live_since) : null;
    const missed = liveSince === null ? 0 : activity.legs.slice(activity.legs.length - added).filter((l) => l.kind === "swap" && Date.parse(l.at) >= liveSince).length;
    const notes = [
      added > 0 ? `${added} new coin move${added === 1 ? "" : "s"}` : "nothing new",
      liveSince !== null ? `webhook missed ${missed}` : "",
      partial ? `partial — over ${MAX_PAGES * 100} transactions since the last check` : "",
      failed.length > 0 ? `not checked: ${failed.join("; ")}` : "",
      notChecked.filter((c) => !VENUES.has(c)).length > 0 ? `no source for ${notChecked.filter((c) => !VENUES.has(c)).join(", ")}` : "",
    ].filter(Boolean);
    const status = notes.join(" · ");
    // Only onto the same read: a full read that finished meanwhile moved the day.
    const { data: saved, error } = await db
      .from("watched_addresses")
      .update({ tx_activity: activity, tx_cursor: cursor, tx_check_status: status })
      .eq("chain", row.chain)
      .eq("address", row.address)
      .eq("last_refresh_at", row.last_refresh_at!)
      .select("chain");
    if (error) throw new Error(error.message);
    if (!saved || saved.length === 0) return outcome(true, "a full read finished meanwhile — check again");
    return outcome(failed.length < sources.length || sources.length === 0, status);
  } catch (e) {
    const status = `error: ${(e as Error).message}`;
    await db.from("watched_addresses").update({ tx_checked_at: row.tx_checked_at, tx_check_status: status }).eq("chain", row.chain).eq("address", row.address);
    return outcome(false, status);
  }
}

/** Each change's coin as the snapshot keys it (watchDiff.ts assetOf):
 * the snapshot's own rows first, then the sync's price-key rules for coins
 * it doesn't hold. A one-way transfer of a coin that's neither in the
 * snapshot nor priced is spam and isn't kept. New coins bought in a swap are
 * priced (one batched pass) so the feed can size them. */
/** USD prices for these keys (a request's cached map, or a direct read). */
export type PriceLookup = (keys: string[]) => Promise<ReadonlyMap<string, number>>;

/** A lookup over a map the caller already has (a check's asset stats). */
export const pricesFromStats = (stats: ReadonlyMap<string, AssetStats>): PriceLookup => async (keys) =>
  new Map(keys.flatMap((k) => {
    const usd = parseNumeric(stats.get(k)?.usd ?? null);
    return usd === null ? [] : [[k, usd] as [string, number]];
  }));

export async function identifyLegs(changes: readonly RawChange[], snapshot: WatchSnapshot, lookup: PriceLookup, checkedAt: string, source: "webhook" | "check"): Promise<ActivityLeg[]> {
  if (changes.length === 0) return [];
  const byContract = contractKeys(snapshot);
  const tickerOf = new Map<string, string>();
  const priceKeyOf = new Map<string, string | null>();
  const nativeOf = new Map<string, { key: string; ticker: string }>();
  for (const r of snapshot.rows) {
    if (r.contract) {
      tickerOf.set(`${r.chain ?? ""}:${r.contract.toLowerCase()}`, r.ticker);
      priceKeyOf.set(`${r.chain ?? ""}:${r.contract.toLowerCase()}`, r.price_key ?? null);
    }
    else if (r.chain && r.price_key && r.category === "token") nativeOf.set(r.chain, { key: r.price_key, ticker: r.ticker });
  }
  const coinId = (c: RawChange) => `${c.chain}:${c.contract?.toLowerCase() ?? "native"}`;
  const unknown = [...new Map(changes.filter((c) => (c.contract ? !byContract.has(coinId(c)) : !nativeOf.has(c.chain))).map((c) => [coinId(c), c])).values()];
  const resolved = await withPriceKeys(
    unknown.map((c) => ({ ticker: c.symbol ?? (c.contract ? c.contract.slice(0, 6) : ""), chain: c.chain, contract: c.contract, category: "token" })),
    "watch",
  );
  const keyOf = new Map(unknown.map((c, i) => [coinId(c), resolved[i].price_key]));
  const identify = (c: RawChange): LegIdentity | null => {
    const id = coinId(c);
    if (!c.contract && nativeOf.has(c.chain)) return { assetKey: nativeOf.get(c.chain)!.key, priceKey: nativeOf.get(c.chain)!.key, ticker: nativeOf.get(c.chain)!.ticker };
    const known = byContract.get(id);
    if (known) return { assetKey: known, priceKey: priceKeyOf.get(id) ?? null, ticker: tickerOf.get(id) ?? c.symbol ?? "?" };
    const key = keyOf.get(id);
    return key ? { assetKey: key, priceKey: key, ticker: c.symbol ?? "" } : null;
  };
  // Every key these changes could touch, priced in one go.
  const candidateKeys = [...new Set([...CASH_KEYS, ...byContract.values(), ...[...nativeOf.values()].map((n) => n.key), ...[...keyOf.values()].filter((k): k is string => !!k)])];
  const priced = await lookup(candidateKeys);
  const priceOf = (k: string | null) => (k ? (priced.get(k) ?? null) : null);
  const valueOf = (k: string | null) => (k && VALUE_KEYS.has(k) ? priceOf(k) : null);
  const inSnapshot = new Set(assetStates(snapshot).keys());
  const legs = toLegs(changes, identify, valueOf, NO_NATIVE_LEGS, checkedAt).filter((l) => l.kind !== "transfer" || inSnapshot.has(l.assetKey) || priceOf(l.priceKey) !== null);

  // New coins from swaps: priced now, and named from the price source.
  for (const l of legs) l.source = source;
  const fresh = [...new Set(legs.filter((l) => l.kind === "swap" && l.priceKey && !priced.has(l.priceKey)).map((l) => l.priceKey!))];
  if (fresh.length > 0) await ensureAssetPrices(fresh, "watch-check").catch(() => {});
  const unnamed = [...new Set(legs.filter((l) => !l.ticker && l.priceKey).map((l) => l.priceKey!))];
  if (unnamed.length > 0) {
    const { data } = await serviceDb().from("assets").select("price_key, symbol").in("price_key", unnamed);
    const symbol = new Map((data as { price_key: string; symbol: string | null }[] | null)?.map((a) => [a.price_key, a.symbol]) ?? []);
    for (const l of legs) if (!l.ticker) l.ticker = (l.priceKey && symbol.get(l.priceKey)?.toUpperCase()) || `${l.priceKey?.replace(/^jup:/, "").slice(0, 4) ?? "?"}…`;
  }
  return legs;
}

/** Checks these addresses: claims them, then reads the claimed ones a few at
 * a time, reporting each the moment it's saved (the route streams them). */
export async function runActivityCheck(
  keys: readonly { chain: string; address: string }[],
  stats: ReadonlyMap<string, AssetStats>,
  onOutcome: (o: CheckOutcome) => void,
): Promise<void> {
  const nowMs = Date.now();
  const { claimed, skipped } = await claimActivityCheck(keys, nowMs);
  for (const s of skipped) onOutcome(s);
  await mapWithConcurrency(claimed, CONCURRENCY, async (row) => onOutcome(await checkAddress(row, stats, nowMs)));
}

import "server-only";
import { cache } from "react";
import { serviceDb, userDb } from "./supabase";
import { getUser } from "./auth";
import { getAssetStatsMap, getPriceMap, valuateHoldings, type ValuatedHoldings } from "./queries";
import { toHolding } from "./lookup";
import { defaultChainId } from "./chainNames";
import { parseNumeric, valueHolding, type PriceMap } from "./valuation";
import { formatTicker } from "./format";
import { snapshotRowToAdapter, type WatchSnapshot } from "./watchSnapshot";
import type { Holding } from "./types";
import { mergeSameCoin } from "./mergeHoldings";
import { contractFromKey, dayLines, type DayLine, type TxActivity } from "./watchActivity";
import { summarizeTrading, type StoredTradingRecord, type TradingSummary } from "./tradingRecord";
import { deriveJobStatus, type JobStatus } from "./jobStatus";

// Wallet Watch reads (docs/wallet-watch/PLAN.md). All through userDb(): the
// user's own influencers/groups (owner-only RLS) and the shared rows of the
// addresses they watch (readable only by their watchers). Values are live —
// the stored snapshot's quantities × today's prices — like every other page.
// Supabase requests per page view: influencers, addresses, groups, group
// links, watched rows, plus the per-request price read.

export interface WatchGroup {
  id: string;
  name: string;
}

export interface WatchedAddressView {
  id: string;
  chain: string;
  address: string;
  /** Null until the first refresh finishes. */
  valueUsd: number | null;
  unpricedCount: number;
  lastRefreshAt: string | null;
  lastRefreshStatus: string | null;
  refreshStatus: string | null;
  refreshStartedAt: string | null;
}

export interface WatchedInfluencer {
  id: string;
  name: string;
  link: string | null;
  /** The owner's own note; never included on a shared page. */
  note: string | null;
  /** Set while the owner shares it (/wallet-watch/shared/<token>). */
  shareToken: string | null;
  groupIds: string[];
  addresses: WatchedAddressView[];
  /** Sum over addresses read at least once; null if none has been. */
  valueUsd: number | null;
  unpricedCount: number;
  /** Largest holdings across all addresses, by current value. */
  topHoldings: { ticker: string; usd: number; iconUrl: string | null }[];
  /** The oldest address refresh (what the whole row is "as of"). */
  lastRefreshAt: string | null;
}

type WatchedRow = {
  chain: string;
  address: string;
  snapshot: WatchSnapshot | null;
  last_refresh_at: string | null;
  last_refresh_status: string | null;
  refresh_status: string | null;
  refresh_started_at: string | null;
};

const TOP_HOLDINGS = 3;

function valueSnapshot(snapshot: WatchSnapshot, prices: PriceMap) {
  let total = 0;
  let unpriced = 0;
  const byAsset = new Map<string, { ticker: string; usd: number; iconUrl: string | null }>();
  for (const r of snapshot.rows) {
    const v = valueHolding({ ticker: r.ticker, qty: r.qty ?? null, usd_override: r.usd_override ?? null, source: "auto", price_key: r.price_key ?? null }, prices);
    if (v.kind !== "priced") {
      unpriced++;
      continue;
    }
    total += v.usd;
    const key = r.price_key ?? `ticker:${r.ticker}`;
    const a = byAsset.get(key) ?? { ticker: formatTicker(r.ticker), usd: 0, iconUrl: r.icon_url ?? null };
    a.usd += v.usd;
    byAsset.set(key, a);
  }
  return { total, unpriced, assets: [...byAsset.values()] };
}

type InfluencerRow = { id: string; name: string; link: string | null; note: string | null; share_token: string | null };
type WatchData = {
  influencers: InfluencerRow[];
  addresses: { id: string; influencer_id: string; chain: string; address: string }[];
  groups: WatchGroup[];
  links: { group_id: string; influencer_id: string }[];
  watched: Map<string, WatchedRow>;
};

const WATCHED_COLUMNS = "chain, address, snapshot, last_refresh_at, last_refresh_status, refresh_status, refresh_started_at";

/** Everything the user watches — or, with `onlyId`, one influencer's rows
 * and only its addresses' snapshots (an influencer page reads its own one
 * or two snapshots, not all of them: 121 KB for 19 addresses, 2026-09-28). */
async function readWatch(onlyId?: string): Promise<WatchData> {
  const db = await userDb();
  const influencersQ = db.from("watch_influencers").select("id, name, link, note, share_token, created_at").order("created_at");
  const addressesQ = db.from("watch_influencer_addresses").select("id, influencer_id, chain, address").order("created_at");
  const linksQ = db.from("watch_group_influencers").select("group_id, influencer_id");
  const [influencers, addresses, groups, links] = await Promise.all([
    onlyId ? influencersQ.eq("id", onlyId) : influencersQ,
    onlyId ? addressesQ.eq("influencer_id", onlyId) : addressesQ,
    db.from("watch_groups").select("id, name").order("created_at"),
    onlyId ? linksQ.eq("influencer_id", onlyId) : linksQ,
  ]);
  const addressRows = (addresses.data ?? []) as { address: string }[];
  const watched = onlyId
    ? addressRows.length === 0
      ? { data: [], error: null }
      : await db.from("watched_addresses").select(WATCHED_COLUMNS).in("address", addressRows.map((a) => a.address))
    : await db.from("watched_addresses").select(WATCHED_COLUMNS);
  for (const r of [influencers, addresses, groups, links, watched]) if (r.error) throw new Error(`Failed to load Wallet Watch: ${r.error.message}`);
  return {
    influencers: influencers.data as InfluencerRow[],
    addresses: addresses.data as { id: string; influencer_id: string; chain: string; address: string }[],
    groups: groups.data as WatchGroup[],
    links: links.data as { group_id: string; influencer_id: string }[],
    watched: new Map((watched.data as WatchedRow[]).map((w) => [`${w.chain}|${w.address}`, w])),
  };
}

export async function getWatchOverview(): Promise<{ groups: WatchGroup[]; influencers: WatchedInfluencer[] }> {
  const { groups, influencers } = await loadOverview();
  return { groups, influencers };
}

/** The overview plus each watched address's stored snapshot, keyed
 * `chain|address` (Watch Insights reads the holdings from it). */
export async function getWatchOverviewWithSnapshots(): Promise<{ groups: WatchGroup[]; influencers: WatchedInfluencer[]; snapshots: Map<string, WatchSnapshot | null> }> {
  const { groups, influencers, watched } = await loadOverview();
  return { groups, influencers, snapshots: new Map([...watched].map(([k, w]) => [k, w.snapshot])) };
}

/** Read once per request (React cache): the list, Insights and the
 * Dashboard can all ask for it. `onlyId`: one influencer's page. */
const loadOverview = cache(async (onlyId?: string): Promise<{ groups: WatchGroup[]; influencers: WatchedInfluencer[]; watched: Map<string, WatchedRow> }> => {
  if (!(await getUser())) return { groups: [], influencers: [], watched: new Map() };
  const [data, prices] = await Promise.all([readWatch(onlyId), getPriceMap()]);
  return { groups: data.groups, influencers: buildInfluencers(data, prices), watched: data.watched };
});

/** Each influencer with its addresses valued from their last read at
 * today's prices. */
function buildInfluencers(data: WatchData, prices: PriceMap): WatchedInfluencer[] {
  return data.influencers.map((inf): WatchedInfluencer => {
    const assets = new Map<string, { ticker: string; usd: number; iconUrl: string | null }>();
    let value: number | null = null;
    let unpricedCount = 0;
    let lastRefreshAt: string | null = null;
    const addresses = data.addresses
      .filter((a) => a.influencer_id === inf.id)
      .map((a): WatchedAddressView => {
        const w = data.watched.get(`${a.chain}|${a.address}`);
        let valueUsd: number | null = null;
        let unpriced = 0;
        if (w?.snapshot) {
          const v = valueSnapshot(w.snapshot, prices);
          valueUsd = v.total;
          unpriced = v.unpriced;
          value = (value ?? 0) + v.total;
          unpricedCount += v.unpriced;
          for (const x of v.assets) {
            const cur = assets.get(x.ticker) ?? { ...x, usd: 0 };
            cur.usd += x.usd;
            assets.set(x.ticker, cur);
          }
        }
        if (w?.last_refresh_at && (lastRefreshAt === null || w.last_refresh_at < lastRefreshAt)) lastRefreshAt = w.last_refresh_at;
        return {
          id: a.id,
          chain: a.chain,
          address: a.address,
          valueUsd,
          unpricedCount: unpriced,
          lastRefreshAt: w?.last_refresh_at ?? null,
          lastRefreshStatus: w?.last_refresh_status ?? null,
          refreshStatus: w?.refresh_status ?? null,
          refreshStartedAt: w?.refresh_started_at ?? null,
        };
      });
    return {
      id: inf.id,
      name: inf.name,
      link: inf.link,
      note: inf.note,
      shareToken: inf.share_token,
      groupIds: data.links.filter((l) => l.influencer_id === inf.id).map((l) => l.group_id),
      addresses,
      valueUsd: value,
      unpricedCount,
      topHoldings: [...assets.values()].sort((x, y) => y.usd - x.usd).slice(0, TOP_HOLDINGS),
      lastRefreshAt,
    };
  });
}

export interface InfluencerDetail {
  influencer: WatchedInfluencer;
  groups: WatchGroup[];
  /** Every address's holdings together, by chain — like the Portfolio tab.
   * Null until at least one address has been read. */
  holdings: ValuatedHoldings | null;
  /** Left out of the list, summed over addresses: holdings under $1 (and
   * what they came to at their read, when known) and unrecognized tokens. */
  notListed: { dustCount: number; dustUsd: number | null; unrecognizedCount: number };
}

async function detailHoldings(influencer: WatchedInfluencer, watched: Map<string, WatchedRow>, merge = false): Promise<Pick<InfluencerDetail, "holdings" | "notListed">> {
  const [prices, stats] = await Promise.all([getPriceMap(), getAssetStatsMap()]);
  const rows: Holding[] = [];
  const notListed = { dustCount: 0, dustUsd: null as number | null, unrecognizedCount: 0 };
  for (const a of influencer.addresses) {
    const snap = watched.get(`${a.chain}|${a.address}`)?.snapshot;
    if (!snap) continue;
    // A row without its own chain (single-chain adapters) takes its address's.
    for (const r of snap.rows) rows.push(toHolding({ ...snapshotRowToAdapter(r), chain: r.chain ?? defaultChainId(a.chain) }, rows.length));
    notListed.dustCount += snap.dustCount ?? 0;
    if (snap.dustUsd != null) notListed.dustUsd = (notListed.dustUsd ?? 0) + snap.dustUsd;
    notListed.unrecognizedCount += snap.unrecognizedCount ?? snap.unrecognized.length;
  }
  const read = influencer.addresses.some((a) => watched.get(`${a.chain}|${a.address}`)?.snapshot);
  return { holdings: read ? valuateHoldings(merge ? mergeSameCoin(rows) : rows, "ethereum", prices, stats) : null, notListed };
}

/** One influencer and the user's groups, without its holdings — lets an
 * influencer page start its other reads while the holdings are valued.
 * Shares getInfluencerDetail's read (React cache). */
export async function getWatchedInfluencer(id: string): Promise<{ influencer: WatchedInfluencer; groups: WatchGroup[] } | null> {
  const overview = await loadOverview(id);
  const influencer = overview.influencers.find((i) => i.id === id);
  return influencer ? { influencer, groups: overview.groups } : null;
}

/** `merge`: one row per coin per chain across addresses (mergeHoldings.ts). */
export async function getInfluencerDetail(id: string, merge = false): Promise<InfluencerDetail | null> {
  const overview = await loadOverview(id);
  const influencer = overview.influencers.find((i) => i.id === id);
  if (!influencer) return null;
  return { influencer, groups: overview.groups, ...(await detailHoldings(influencer, overview.watched, merge)) };
}

/**
 * An influencer someone shared (/wallet-watch/shared/<token>), for any
 * signed-in user: read with the service role once the token matches, since
 * the viewer isn't the owner or a watcher. The owner's note, groups and
 * refresh state aren't part of it. Null for an unknown or revoked token.
 */
export async function getSharedInfluencer(token: string, merge = false): Promise<(Omit<InfluencerDetail, "groups"> & { movements: WatchMovementView[]; daily: { date: string; total: number }[] }) | null> {
  if (!(await getUser()) || !/^[0-9a-f-]{36}$/.test(token)) return null;
  const db = serviceDb();
  const { data: inf, error } = await db.from("watch_influencers").select("id, name, link, share_token").eq("share_token", token).maybeSingle();
  if (error) throw new Error(`Failed to load the shared wallet: ${error.message}`);
  if (!inf) return null;
  const { data: addresses, error: addrError } = await db.from("watch_influencer_addresses").select("id, influencer_id, chain, address").eq("influencer_id", inf.id).order("created_at");
  if (addrError) throw new Error(`Failed to load the shared wallet: ${addrError.message}`);
  const list = addresses as WatchData["addresses"];
  const { data: watchedRows, error: watchedError } = list.length
    ? await db.from("watched_addresses").select("chain, address, snapshot, last_refresh_at, last_refresh_status, refresh_status, refresh_started_at").in("address", list.map((a) => a.address))
    : { data: [], error: null };
  if (watchedError) throw new Error(`Failed to load the shared wallet: ${watchedError.message}`);
  const watched = new Map((watchedRows as WatchedRow[]).map((w) => [`${w.chain}|${w.address}`, w]));
  const data: WatchData = { influencers: [{ ...(inf as Omit<InfluencerRow, "note">), note: null }], addresses: list, groups: [], links: [], watched };
  const [influencer] = buildInfluencers(data, await getPriceMap());
  const [detail, movements, daily] = await Promise.all([detailHoldings(influencer, watched, merge), getWatchMovements([influencer], undefined, db), getInfluencerDailyValue(influencer, db)]);
  return { influencer: { ...influencer, shareToken: null }, ...detail, movements, daily };
}

/** One job status for several addresses: running while any is, as of the
 * latest start; the outcome is the worst of the finished ones. */
export function watchJobStatus(addresses: readonly WatchedAddressView[], nowMs: number): JobStatus {
  const each = addresses.map((a) => deriveJobStatus({ status: a.refreshStatus, started_at: a.refreshStartedAt }, nowMs));
  const startedAt = addresses.map((a) => a.refreshStartedAt).filter((t): t is string => !!t).sort().at(-1) ?? null;
  const running = each.some((s) => s.running);
  const rank: Record<string, number> = { error: 3, "timed-out": 2, partial: 1, ok: 0 };
  const worst = each.filter((s) => s.outcome).sort((x, y) => rank[y.outcome!] - rank[x.outcome!])[0];
  return {
    running,
    stale: !running && each.some((s) => s.stale),
    startedAt,
    outcome: running ? null : (worst?.outcome ?? null),
    detail: running ? "syncing" : (worst?.detail ?? null),
    // Only the cron is reading: shown as reading, never polled for.
    scheduled: running && each.every((s) => !s.running || s.scheduled),
  };
}

export interface WatchMovementView {
  id: number;
  influencerId: string;
  influencerName: string;
  address: string;
  snapshotAt: string;
  assetKey: string;
  priceKey: string | null;
  kind: "new" | "added" | "trimmed" | "exited";
  positionType: "token" | "perp" | "prediction";
  ticker: string;
  label: string | null;
  side: string | null;
  qtyBefore: number;
  qtyAfter: number;
  priceUsd: number | null;
  usdDelta: number | null;
  /** usdDelta as a share of the wallet after the read (conviction). */
  walletShare: number | null;
  /** The token's contract / mint (the copy button): stored with the
   * movement, else spelled out by its key; null for a native coin or when
   * the coin had several. */
  contract: string | null;
  /** The coin's stored price now (asset_prices) and when it was priced —
   * only when priced after this move, so it can say how far the price has
   * run since. Tokens only. */
  nowUsd: number | null;
  nowAt: string | null;
}

const FEED_LIMIT = 100;

/** What the activity feed needs of an influencer. */
export type WatchFeedInfluencer = Pick<WatchedInfluencer, "id" | "name" | "groupIds"> & {
  addresses: readonly { chain: string; address: string }[];
};

/** The user's groups and influencers without any snapshot — for a feed
 * shown outside Wallet Watch (the Dashboard), which has no use for the
 * snapshots getWatchOverview reads. Four small requests. */
export async function getWatchFeedTargets(): Promise<{ groups: WatchGroup[]; influencers: WatchFeedInfluencer[] }> {
  const db = await userDb();
  const [influencers, addresses, groups, links] = await Promise.all([
    db.from("watch_influencers").select("id, name").order("created_at"),
    db.from("watch_influencer_addresses").select("influencer_id, chain, address"),
    db.from("watch_groups").select("id, name").order("created_at"),
    db.from("watch_group_influencers").select("group_id, influencer_id"),
  ]);
  for (const r of [influencers, addresses, groups, links]) if (r.error) throw new Error(`Failed to load Wallet Watch: ${r.error.message}`);
  const addrs = addresses.data as { influencer_id: string; chain: string; address: string }[];
  const lnks = links.data as { group_id: string; influencer_id: string }[];
  return {
    groups: groups.data as WatchGroup[],
    influencers: (influencers.data as { id: string; name: string }[]).map((i) => ({
      id: i.id,
      name: i.name,
      groupIds: lnks.filter((l) => l.influencer_id === i.id).map((l) => l.group_id),
      addresses: addrs.filter((a) => a.influencer_id === i.id),
    })),
  };
}

/** The latest movements of these influencers' addresses, newest first
 * (watched_movements, phase 2). One request. */
export async function getWatchMovements(influencers: readonly WatchFeedInfluencer[], limit = FEED_LIMIT, client?: Awaited<ReturnType<typeof userDb>>): Promise<WatchMovementView[]> {
  const byAddress = new Map<string, WatchFeedInfluencer>();
  for (const i of influencers) for (const a of i.addresses) byAddress.set(`${a.chain}|${a.address}`, i);
  if (byAddress.size === 0) return [];
  const db = client ?? (await userDb());
  const { data, error } = await db
    .from("watched_movements")
    .select("id, chain, address, snapshot_at, asset_key, price_key, kind, position_type, ticker, label, side, qty_before, qty_after, price_usd, usd_delta, wallet_total_usd_after, contract")
    .in("address", [...new Set(influencers.flatMap((i) => i.addresses.map((a) => a.address)))])
    .order("snapshot_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load movements: ${error.message}`);
  const stats = await getAssetStatsMap();
  const num = (v: unknown) => parseNumeric(v as number | string | null);
  return (data as Record<string, unknown>[]).flatMap((r) => {
    const inf = byAddress.get(`${r.chain}|${r.address}`);
    if (!inf) return [];
    const usd = num(r.usd_delta);
    const total = num(r.wallet_total_usd_after);
    const now = r.position_type === "token" && r.price_key ? stats.get(r.price_key as string) : undefined;
    const priceIsNewer = !!now && now.usd !== null && !!now.updatedAt && Date.parse(now.updatedAt) > Date.parse(r.snapshot_at as string);
    return [
      {
        id: r.id as number,
        influencerId: inf.id,
        influencerName: inf.name,
        address: r.address as string,
        snapshotAt: r.snapshot_at as string,
        assetKey: r.asset_key as string,
        priceKey: (r.price_key as string | null) ?? null,
        kind: r.kind as WatchMovementView["kind"],
        positionType: r.position_type as WatchMovementView["positionType"],
        ticker: r.ticker as string,
        label: (r.label as string | null) ?? null,
        side: (r.side as string | null) ?? null,
        qtyBefore: num(r.qty_before) ?? 0,
        qtyAfter: num(r.qty_after) ?? 0,
        priceUsd: num(r.price_usd),
        usdDelta: usd,
        walletShare: usd !== null && total !== null && total > 0 ? Math.abs(usd) / total : null,
        contract: r.position_type === "token" ? ((r.contract as string | null) ?? contractFromKey(r.asset_key as string)) : null,
        nowUsd: priceIsNewer ? now!.usd : null,
        nowAt: priceIsNewer ? now!.updatedAt : null,
      },
    ];
  });
}

/** One line of an influencer's day from the activity check (phase 4). */
export interface WatchDayLine extends DayLine {
  influencerId: string;
  influencerName: string;
  /** The coin's stored price and when it was priced (for "now … (+x%)"). */
  nowUsd: number | null;
  nowAt: string | null;
}

/** What the activity check found today, per influencer: the day's lines,
 * when its addresses were last checked, and what couldn't be checked. One
 * request (the price map is the page's own, cached). */
export async function getWatchDayActivity(
  influencers: readonly WatchFeedInfluencer[],
  client?: Awaited<ReturnType<typeof userDb>>,
): Promise<{ lines: WatchDayLine[]; checkedAt: Record<string, string>; issues: { influencerId: string; address: string; status: string }[] }> {
  const addresses = [...new Set(influencers.flatMap((i) => i.addresses.map((a) => a.address)))];
  if (addresses.length === 0) return { lines: [], checkedAt: {}, issues: [] };
  const db = client ?? (await userDb());
  const [{ data, error }, stats] = await Promise.all([
    db.from("watched_addresses").select("chain, address, tx_activity, tx_checked_at, tx_check_status").in("address", addresses),
    getAssetStatsMap(),
  ]);
  if (error) throw new Error(`Failed to load today's activity: ${error.message}`);
  const rows = new Map((data as { chain: string; address: string; tx_activity: TxActivity | null; tx_checked_at: string | null; tx_check_status: string | null }[]).map((r) => [`${r.chain}|${r.address}`, r]));
  const priceNow = (k: string | null) => (k ? parseNumeric(stats.get(k)?.usd ?? null) : null);
  const lines: WatchDayLine[] = [];
  const checkedAt: Record<string, string> = {};
  const issues: { influencerId: string; address: string; status: string }[] = [];
  for (const i of influencers) {
    const mine = i.addresses.map((a) => rows.get(`${a.chain}|${a.address}`)).filter((r) => !!r);
    const latest = mine.map((r) => r.tx_checked_at).filter((t): t is string => !!t).sort().at(-1);
    if (latest) checkedAt[i.id] = latest;
    for (const r of mine) if (r.tx_check_status && /error|not checked|partial|no source/.test(r.tx_check_status)) issues.push({ influencerId: i.id, address: r.address, status: r.tx_check_status });
    const activities = mine.map((r) => r.tx_activity).filter((a): a is TxActivity => !!a);
    for (const l of dayLines(activities, new Set(i.addresses.map((a) => a.address)), priceNow)) lines.push({ ...l, influencerId: i.id, influencerName: i.name, nowUsd: priceNow(l.priceKey), nowAt: (l.priceKey && stats.get(l.priceKey)?.updatedAt) || null });
  }
  return { lines: lines.sort((x, y) => y.lastAt.localeCompare(x.lastAt)), checkedAt, issues };
}

/** An influencer's trading record (tradingRecord.ts): its Solana
 * addresses' stored records, summarized. One request; never calls the API. */
export async function getTradingRecord(influencer: WatchFeedInfluencer, today: string): Promise<{
  summary: TradingSummary | null;
  loadedAt: string | null;
  solanaAddresses: number;
  otherAddresses: number;
  errors: string[];
}> {
  const sol = influencer.addresses.filter((a) => a.chain === "SOL").map((a) => a.address);
  const otherAddresses = influencer.addresses.length - sol.length;
  if (sol.length === 0) return { summary: null, loadedAt: null, solanaAddresses: 0, otherAddresses, errors: [] };
  const db = await userDb();
  const { data, error } = await db.from("watched_addresses").select("address, trading_record, trading_record_at, trading_record_status").eq("chain", "SOL").in("address", sol);
  if (error) throw new Error(`Failed to load the trading record: ${error.message}`);
  const rows = data as { address: string; trading_record: StoredTradingRecord | null; trading_record_at: string | null; trading_record_status: string | null }[];
  const records = rows.map((r) => r.trading_record).filter((r): r is StoredTradingRecord => !!r);
  return {
    summary: summarizeTrading(records, today),
    loadedAt: rows.map((r) => r.trading_record_at).filter((t): t is string => !!t).sort()[0] ?? null,
    solanaAddresses: sol.length,
    otherAddresses,
    errors: rows.filter((r) => r.trading_record_status?.startsWith("error")).map((r) => `${r.address.slice(0, 6)}…: ${r.trading_record_status}`),
  };
}

/** An influencer's value per day: the sum of its addresses' daily rows, only
 * on days every address has one (a partial day would look like a drop). */
export async function getInfluencerDailyValue(influencer: WatchedInfluencer, client?: Awaited<ReturnType<typeof userDb>>): Promise<{ date: string; total: number }[]> {
  if (influencer.addresses.length === 0) return [];
  const db = client ?? (await userDb());
  const { data, error } = await db
    .from("watched_address_daily")
    .select("chain, address, day, total_usd")
    .in("address", influencer.addresses.map((a) => a.address))
    .order("day");
  if (error) throw new Error(`Failed to load value history: ${error.message}`);
  const byDay = new Map<string, { total: number; n: number }>();
  for (const r of data as { day: string; total_usd: number | string }[]) {
    const d = byDay.get(r.day) ?? { total: 0, n: 0 };
    d.total += parseNumeric(r.total_usd) ?? 0;
    d.n++;
    byDay.set(r.day, d);
  }
  return [...byDay].filter(([, d]) => d.n === influencer.addresses.length).map(([date, d]) => ({ date, total: d.total }));
}

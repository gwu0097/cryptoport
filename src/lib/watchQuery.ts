import "server-only";
import { userDb } from "./supabase";
import { getUser } from "./auth";
import { getAssetStatsMap, getPriceMap, valuateHoldings, type ValuatedHoldings } from "./queries";
import { toHolding } from "./lookup";
import { defaultChainId } from "./chainNames";
import { parseNumeric, valueHolding, type PriceMap } from "./valuation";
import { formatTicker } from "./format";
import { snapshotRowToAdapter, type WatchSnapshot } from "./watchSnapshot";
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
  note: string | null;
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

async function readWatch() {
  const db = await userDb();
  const [influencers, addresses, groups, links, watched] = await Promise.all([
    db.from("watch_influencers").select("id, name, link, note, created_at").order("created_at"),
    db.from("watch_influencer_addresses").select("id, influencer_id, chain, address").order("created_at"),
    db.from("watch_groups").select("id, name").order("created_at"),
    db.from("watch_group_influencers").select("group_id, influencer_id"),
    db.from("watched_addresses").select("chain, address, snapshot, last_refresh_at, last_refresh_status, refresh_status, refresh_started_at"),
  ]);
  for (const r of [influencers, addresses, groups, links, watched]) if (r.error) throw new Error(`Failed to load Wallet Watch: ${r.error.message}`);
  return {
    influencers: influencers.data as { id: string; name: string; link: string | null; note: string | null }[],
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

async function loadOverview(): Promise<{ groups: WatchGroup[]; influencers: WatchedInfluencer[]; watched: Map<string, WatchedRow> }> {
  if (!(await getUser())) return { groups: [], influencers: [], watched: new Map() };
  const [data, prices] = await Promise.all([readWatch(), getPriceMap()]);
  const influencers = data.influencers.map((inf): WatchedInfluencer => {
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
      groupIds: data.links.filter((l) => l.influencer_id === inf.id).map((l) => l.group_id),
      addresses,
      valueUsd: value,
      unpricedCount,
      topHoldings: [...assets.values()].sort((x, y) => y.usd - x.usd).slice(0, TOP_HOLDINGS),
      lastRefreshAt,
    };
  });
  return { groups: data.groups, influencers, watched: data.watched };
}

export interface InfluencerDetail {
  influencer: WatchedInfluencer;
  groups: WatchGroup[];
  /** Per address, its holdings valued like a wallet's (by chain). */
  holdings: { address: WatchedAddressView; valuated: ValuatedHoldings | null; unrecognizedCount: number; dust: { count: number; usd: number | null } }[];
}

export async function getInfluencerDetail(id: string): Promise<InfluencerDetail | null> {
  const overview = await loadOverview();
  const influencer = overview.influencers.find((i) => i.id === id);
  if (!influencer) return null;
  // Both cached per request: the overview above already read them.
  const [prices, stats] = await Promise.all([getPriceMap(), getAssetStatsMap()]);
  return {
    influencer,
    groups: overview.groups,
    holdings: influencer.addresses.map((a) => {
      const snap = overview.watched.get(`${a.chain}|${a.address}`)?.snapshot ?? null;
      return {
        address: a,
        valuated: snap ? valuateHoldings(snap.rows.map((r, i) => toHolding(snapshotRowToAdapter(r), i)), defaultChainId(a.chain), prices, stats) : null,
        unrecognizedCount: snap?.unrecognizedCount ?? snap?.unrecognized.length ?? 0,
        dust: { count: snap?.dustCount ?? 0, usd: snap?.dustUsd ?? null },
      };
    }),
  };
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
  };
}

export interface WatchMovementView {
  id: number;
  influencerId: string;
  influencerName: string;
  address: string;
  snapshotAt: string;
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
}

const FEED_LIMIT = 100;

/** The latest movements of these influencers' addresses, newest first
 * (watched_movements, phase 2). One request. */
export async function getWatchMovements(influencers: readonly WatchedInfluencer[], limit = FEED_LIMIT): Promise<WatchMovementView[]> {
  const byAddress = new Map<string, WatchedInfluencer>();
  for (const i of influencers) for (const a of i.addresses) byAddress.set(`${a.chain}|${a.address}`, i);
  if (byAddress.size === 0) return [];
  const db = await userDb();
  const { data, error } = await db
    .from("watched_movements")
    .select("id, chain, address, snapshot_at, kind, position_type, ticker, label, side, qty_before, qty_after, price_usd, usd_delta, wallet_total_usd_after")
    .in("address", [...new Set(influencers.flatMap((i) => i.addresses.map((a) => a.address)))])
    .order("snapshot_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load movements: ${error.message}`);
  const num = (v: unknown) => parseNumeric(v as number | string | null);
  return (data as Record<string, unknown>[]).flatMap((r) => {
    const inf = byAddress.get(`${r.chain}|${r.address}`);
    if (!inf) return [];
    const usd = num(r.usd_delta);
    const total = num(r.wallet_total_usd_after);
    return [
      {
        id: r.id as number,
        influencerId: inf.id,
        influencerName: inf.name,
        address: r.address as string,
        snapshotAt: r.snapshot_at as string,
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
      },
    ];
  });
}

/** An influencer's value per day: the sum of its addresses' daily rows, only
 * on days every address has one (a partial day would look like a drop). */
export async function getInfluencerDailyValue(influencer: WatchedInfluencer): Promise<{ date: string; total: number }[]> {
  if (influencer.addresses.length === 0) return [];
  const db = await userDb();
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

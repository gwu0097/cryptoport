import "server-only";
import { userDb } from "./supabase";
import { getActiveWalletsWithHoldings, getPriceMap } from "./queries";
import { getPriceHistoryMap } from "./priceHistory";
import { getWatchMovements, getWatchOverviewWithSnapshots, type WatchGroup, type WatchedInfluencer, type WatchMovementView } from "./watchQuery";
import { assetOf } from "./watchDiff";
import { parseNumeric, valueHolding, type PriceMap } from "./valuation";
import { formatTicker } from "./format";
import { coinFlows, earlyOrLate, sharedHoldings, trackRecord, type Convergence, type InfluencerHoldings, type SharedHolding, type TrackRecord } from "./watchInsights";
import type { Holding } from "./types";
import type { WatchSnapshot } from "./watchSnapshot";

// Watch Insights' one read (docs/wallet-watch/PLAN.md, phase 3). Stored data
// only — no external call. Supabase requests per view: the Wallet Watch
// overview (5), movements, positions, daily rows, the user's own holdings,
// prices, and price history for the coins traded since watching began.

export type InsightWindow = "7d" | "30d";
export const WINDOW_DAYS: Record<InsightWindow, number> = { "7d": 7, "30d": 30 };

export interface InfluencerCard {
  influencer: WatchedInfluencer;
  /** Value change over the window from the daily rows; null without a row that old. */
  valueChangePct: number | null;
  /** Cash-like share now, and at the start of the window. */
  cashShare: number | null;
  cashShareBefore: number | null;
  moves: { buys: number; sells: number; boughtUsd: number; soldUsd: number };
  record: TrackRecord;
  /** Early/late per trade opened since watching (null parts: no history). */
  entries: { ticker: string; openedAt: string; before30d: number | null; since: number | null }[];
  openPerps: { ticker: string; side: string; sizeUsd: number | null; leverage: number | null; entry: number | null; liquidation: number | null }[];
}

export interface WatchInsights {
  groups: WatchGroup[];
  selected: WatchGroup | null;
  influencerCount: number;
  window: InsightWindow;
  /** The earliest movement on record (movements start after a second read). */
  movementsSince: string | null;
  converging: (Convergence & { names: string[]; otherGroups: string[] })[];
  flows: (Convergence & { names: string[] })[];
  shared: (SharedHolding & { otherGroups: string[] })[];
  /** The user's own coins that the group moved in the window. */
  overlap: { ticker: string; mineUsd: number; buyers: string[]; sellers: string[]; netUsd: number }[];
  cards: InfluencerCard[];
}

const num = (v: unknown) => parseNumeric(v as number | string | null);

function holdingsOf(influencer: WatchedInfluencer, snapshots: Map<string, WatchSnapshot | null>, prices: PriceMap): InfluencerHoldings {
  const assets = new Map<string, { ticker: string; priceKey: string | null; usd: number }>();
  let total = 0;
  for (const a of influencer.addresses) {
    for (const r of snapshots.get(`${a.chain}|${a.address}`)?.rows ?? []) {
      const v = valueHolding({ ticker: r.ticker, qty: r.qty ?? null, usd_override: r.usd_override ?? null, source: "auto", price_key: r.price_key ?? null }, prices);
      if (v.kind !== "priced") continue;
      total += v.usd;
      const asset = assetOf(r);
      if (!asset || asset.type !== "token") continue;
      const cur = assets.get(asset.key) ?? { ticker: formatTicker(r.ticker), priceKey: asset.priceKey, usd: 0 };
      cur.usd += v.usd;
      assets.set(asset.key, cur);
    }
  }
  return { influencerId: influencer.id, name: influencer.name, totalUsd: total, assets };
}

export async function getWatchInsights(groupId: string | undefined, window: InsightWindow): Promise<WatchInsights> {
  const [{ groups, influencers: all, snapshots }, prices, myWallets] = await Promise.all([getWatchOverviewWithSnapshots(), getPriceMap(), getActiveWalletsWithHoldings()]);
  const selected = groups.find((g) => g.id === groupId) ?? null;
  const influencers = selected ? all.filter((i) => i.groupIds.includes(selected.id)) : all;
  const nameOf = new Map(all.map((i) => [i.id, i.name]));
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS[window] * 86_400_000).toISOString();

  const addresses = [...new Set(influencers.flatMap((i) => i.addresses.map((a) => a.address)))];
  const db = await userDb();
  const [movementsAll, positionsRes, dailyRes] = await Promise.all([
    getWatchMovements(influencers, 1000),
    addresses.length ? db.from("watched_positions").select("*").in("address", addresses) : Promise.resolve({ data: [], error: null }),
    addresses.length ? db.from("watched_address_daily").select("chain, address, day, total_usd, cash_usd").in("address", addresses).gte("day", since.slice(0, 10)).order("day") : Promise.resolve({ data: [], error: null }),
  ]);
  if (positionsRes.error) throw new Error(`Failed to load positions: ${positionsRes.error.message}`);
  if (dailyRes.error) throw new Error(`Failed to load daily values: ${dailyRes.error.message}`);
  const movements = movementsAll.filter((m) => m.snapshotAt >= since);
  const toInput = (m: WatchMovementView) => ({ influencerId: m.influencerId, assetKey: m.assetKey, ticker: m.ticker, priceKey: m.priceKey, kind: m.kind, usdDelta: m.usdDelta, walletShare: m.walletShare, snapshotAt: m.snapshotAt });

  // Viewing one group: which of the user's other groups also have a holder
  // or buyer of the coin (cross-group convergence). Not shown on "All".
  const groupsHolding = (holders: string[]) =>
    selected ? groups.filter((g) => g.id !== selected.id && all.some((i) => i.groupIds.includes(g.id) && !i.groupIds.includes(selected.id) && holders.includes(i.id))).map((g) => g.name) : [];

  const holdings = influencers.map((i) => holdingsOf(i, snapshots, prices));
  const mine = new Map<string, number>();
  for (const w of myWallets) for (const h of w.holdings) {
    if (!h.price_key) continue;
    const v = valueHolding(h, prices);
    if (v.kind === "priced") mine.set(h.price_key, (mine.get(h.price_key) ?? 0) + v.usd);
  }

  const withNames = <T extends Convergence>(c: T) => ({ ...c, names: c.buyers.map((b) => nameOf.get(b.influencerId) ?? "?") });
  const converging = coinFlows(movements.map(toInput), 2).map((c) => ({ ...withNames(c), otherGroups: groupsHolding(c.buyers.map((b) => b.influencerId)) }));
  const flows = coinFlows(movements.map(toInput), 0).map(withNames);
  const shared = sharedHoldings(holdings).map((s) => ({ ...s, otherGroups: groupsHolding(s.holders.map((h) => h.influencerId)) }));
  const overlap = flows
    .filter((f) => f.priceKey && mine.has(f.priceKey))
    .map((f) => ({ ticker: f.ticker, mineUsd: mine.get(f.priceKey!)!, buyers: f.buyers.map((b) => nameOf.get(b.influencerId) ?? "?"), sellers: f.sellers.map((s) => nameOf.get(s.influencerId) ?? "?"), netUsd: f.netUsd }));

  // Per influencer: value and cash over the window, moves, track record.
  const positions = (positionsRes.data as Record<string, unknown>[]).map((p) => ({
    address: p.address as string,
    assetKey: p.asset_key as string,
    ticker: p.ticker as string,
    priceKey: (p.price_key as string | null) ?? null,
    heldAtStart: p.held_at_start as boolean,
    openedAt: p.opened_at as string,
    entryPrice: num(p.entry_price),
    closedAt: (p.closed_at as string | null) ?? null,
    exitPrice: num(p.exit_price),
  }));
  const tradedKeys = [...new Set(positions.filter((p) => !p.heldAtStart && p.priceKey).map((p) => p.priceKey!))];
  const history = tradedKeys.length
    ? (await getPriceHistoryMap(tradedKeys.map((k) => ({ ticker: k, source: "auto", contract: null, chain: null, coingecko_id: k, price_key: k }) as Pick<Holding, "ticker" | "source" | "contract" | "chain" | "coingecko_id" | "price_key">))).history
    : new Map();
  const priceNow = (key: string | null) => (key ? num(prices[key]) : null);
  const daily = dailyRes.data as { address: string; day: string; total_usd: number | string; cash_usd: number | string | null }[];

  const cards: InfluencerCard[] = influencers.map((inf) => {
    const addrs = new Set(inf.addresses.map((a) => a.address));
    const byDay = new Map<string, { total: number; cash: number; n: number }>();
    for (const d of daily) {
      if (!addrs.has(d.address)) continue;
      const x = byDay.get(d.day) ?? { total: 0, cash: 0, n: 0 };
      x.total += num(d.total_usd) ?? 0;
      x.cash += num(d.cash_usd) ?? 0;
      x.n++;
      byDay.set(d.day, x);
    }
    const complete = [...byDay].filter(([, x]) => x.n === addrs.size).sort(([a], [b]) => a.localeCompare(b));
    const first = complete[0]?.[1];
    const last = complete.at(-1)?.[1];
    const mine = movements.filter((m) => m.influencerId === inf.id);
    const own = positions.filter((p) => addrs.has(p.address));
    const record = trackRecord(own.map((p) => ({ ...p, influencerId: inf.id })), priceNow, now.toISOString());
    const openPerps = inf.addresses.flatMap((a) =>
      (snapshots.get(`${a.chain}|${a.address}`)?.rows ?? [])
        .filter((r) => r.position_side)
        .map((r) => ({
          ticker: r.ticker,
          side: r.position_side!,
          sizeUsd: r.qty != null && r.position_entry_price != null ? Math.abs(r.qty) * r.position_entry_price : null,
          leverage: r.position_leverage ?? null,
          entry: r.position_entry_price ?? null,
          liquidation: r.position_liquidation_price ?? null,
        })),
    );
    return {
      influencer: inf,
      valueChangePct: first && last && complete.length > 1 && first.total > 0 ? last.total / first.total - 1 : null,
      cashShare: last && last.total > 0 ? last.cash / last.total : null,
      cashShareBefore: first && complete.length > 1 && first.total > 0 ? first.cash / first.total : null,
      moves: {
        buys: mine.filter((m) => m.kind === "new" || m.kind === "added").length,
        sells: mine.filter((m) => m.kind === "trimmed" || m.kind === "exited").length,
        boughtUsd: mine.reduce((s, m) => s + Math.max(0, m.usdDelta ?? 0), 0),
        soldUsd: mine.reduce((s, m) => s + Math.min(0, m.usdDelta ?? 0), 0),
      },
      record,
      entries: own
        .filter((p) => !p.heldAtStart && p.entryPrice !== null)
        .map((p) => ({ ticker: p.ticker, openedAt: p.openedAt, ...earlyOrLate(p.openedAt, p.entryPrice!, p.priceKey ? history.get(p.priceKey) : undefined, priceNow(p.priceKey)) })),
      openPerps,
    };
  });

  return {
    groups,
    selected,
    influencerCount: influencers.length,
    window,
    movementsSince: movementsAll.map((m) => m.snapshotAt).sort()[0] ?? null,
    converging,
    flows,
    shared,
    overlap,
    cards,
  };
}

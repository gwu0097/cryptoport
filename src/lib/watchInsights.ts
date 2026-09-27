// Watch Insights (docs/wallet-watch/PLAN.md, phase 3): what a group of
// watched influencers has in common and how their moves have worked out.
// Pure — the data comes from watchInsightsQuery.ts. Observations, not
// signals: every figure says what it's based on, and what the data can't
// say is "—".

/** One influencer's current holdings, per asset (watchDiff.ts assetOf key). */
export interface InfluencerHoldings {
  influencerId: string;
  name: string;
  totalUsd: number;
  assets: ReadonlyMap<string, { ticker: string; priceKey: string | null; usd: number }>;
}

export interface MovementInput {
  influencerId: string;
  assetKey: string;
  ticker: string;
  priceKey: string | null;
  kind: "new" | "added" | "trimmed" | "exited";
  usdDelta: number | null;
  /** |usdDelta| ÷ the wallet after the move. */
  walletShare: number | null;
  snapshotAt: string;
}

/** A coin counts as shared when at least this many influencers hold it … */
export const MIN_HOLDERS = 2;
/** … each with at least this share of their wallet in it (so a whale's dust
 * doesn't count as conviction). */
export const MIN_HOLDING_SHARE = 0.005;

export interface SharedHolding {
  assetKey: string;
  ticker: string;
  priceKey: string | null;
  holders: { influencerId: string; name: string; usd: number; share: number }[];
  totalUsd: number;
  /** Mean of the holders' shares of their own wallets. */
  avgShare: number;
}

/** Coins at least MIN_HOLDERS influencers hold now, most holders first,
 * then by average conviction. */
export function sharedHoldings(influencers: readonly InfluencerHoldings[]): SharedHolding[] {
  const byAsset = new Map<string, SharedHolding>();
  for (const inf of influencers) {
    if (inf.totalUsd <= 0) continue;
    for (const [key, a] of inf.assets) {
      const share = a.usd / inf.totalUsd;
      if (share < MIN_HOLDING_SHARE) continue;
      const s = byAsset.get(key) ?? { assetKey: key, ticker: a.ticker, priceKey: a.priceKey, holders: [], totalUsd: 0, avgShare: 0 };
      s.holders.push({ influencerId: inf.influencerId, name: inf.name, usd: a.usd, share });
      s.totalUsd += a.usd;
      byAsset.set(key, s);
    }
  }
  return [...byAsset.values()]
    .filter((s) => s.holders.length >= MIN_HOLDERS)
    .map((s) => ({ ...s, avgShare: s.holders.reduce((x, h) => x + h.share, 0) / s.holders.length, holders: s.holders.sort((a, b) => b.share - a.share) }))
    .sort((a, b) => b.holders.length - a.holders.length || b.avgShare - a.avgShare);
}

export interface Convergence {
  assetKey: string;
  ticker: string;
  priceKey: string | null;
  /** Influencers who bought or added in the window (net positive). */
  buyers: { influencerId: string; usd: number; walletShare: number | null; firstAt: string }[];
  sellers: { influencerId: string; usd: number }[];
  netUsd: number;
  firstBuyAt: string;
}

/**
 * Per coin, who bought and who sold within the movements given (already cut
 * to a window). An influencer counts once per coin, by their net dollars.
 * `minBuyers` > 1 gives the converging buys; 1 gives every coin's flow.
 */
export function coinFlows(movements: readonly MovementInput[], minBuyers = 1): Convergence[] {
  type Acc = { ticker: string; priceKey: string | null; per: Map<string, { usd: number; share: number; firstAt: string }> };
  const byAsset = new Map<string, Acc>();
  for (const m of movements) {
    if (m.usdDelta === null) continue;
    const acc = byAsset.get(m.assetKey) ?? { ticker: m.ticker, priceKey: m.priceKey, per: new Map() };
    const p = acc.per.get(m.influencerId) ?? { usd: 0, share: 0, firstAt: m.snapshotAt };
    p.usd += m.usdDelta;
    if (m.usdDelta > 0) p.share += m.walletShare ?? 0;
    if (m.snapshotAt < p.firstAt) p.firstAt = m.snapshotAt;
    acc.per.set(m.influencerId, p);
    byAsset.set(m.assetKey, acc);
  }
  const out: Convergence[] = [];
  for (const [assetKey, acc] of byAsset) {
    const buyers = [...acc.per].filter(([, p]) => p.usd > 0).map(([influencerId, p]) => ({ influencerId, usd: p.usd, walletShare: p.share || null, firstAt: p.firstAt }));
    const sellers = [...acc.per].filter(([, p]) => p.usd < 0).map(([influencerId, p]) => ({ influencerId, usd: p.usd }));
    if (buyers.length < minBuyers) continue;
    out.push({
      assetKey,
      ticker: acc.ticker,
      priceKey: acc.priceKey,
      buyers: buyers.sort((a, b) => a.firstAt.localeCompare(b.firstAt)),
      sellers,
      netUsd: [...acc.per.values()].reduce((s, p) => s + p.usd, 0),
      firstBuyAt: buyers.map((b) => b.firstAt).sort()[0] ?? "",
    });
  }
  return out.sort((a, b) => b.buyers.length - a.buyers.length || b.netUsd - a.netUsd);
}

export interface PositionInput {
  influencerId: string;
  assetKey: string;
  ticker: string;
  priceKey: string | null;
  heldAtStart: boolean;
  openedAt: string;
  entryPrice: number | null;
  closedAt: string | null;
  exitPrice: number | null;
}

export interface TradeResult {
  assetKey: string;
  ticker: string;
  openedAt: string;
  closedAt: string | null;
  /** exit (or current) ÷ entry − 1. */
  returnPct: number;
  holdDays: number;
  open: boolean;
}

export interface TrackRecord {
  /** Positions opened since watching began, with a known entry. */
  trades: TradeResult[];
  closed: number;
  /** Share of closed trades that returned more than 0. Null with none closed. */
  winRate: number | null;
  medianHoldDays: number | null;
  avgClosedReturn: number | null;
  best: TradeResult | null;
  worst: TradeResult | null;
}

const DAY_MS = 86_400_000;
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * An influencer's calls since we started watching: every position opened
 * after the first read (held-at-start ones have no known entry and are left
 * out), closed at its exit price or still open at `currentPrice`.
 */
export function trackRecord(positions: readonly PositionInput[], currentPrice: (priceKey: string | null) => number | null, nowIso: string): TrackRecord {
  const trades: TradeResult[] = [];
  for (const p of positions) {
    if (p.heldAtStart || p.entryPrice === null || p.entryPrice <= 0) continue;
    const exit = p.closedAt ? p.exitPrice : currentPrice(p.priceKey);
    if (exit === null) continue;
    const end = p.closedAt ?? nowIso;
    trades.push({
      assetKey: p.assetKey,
      ticker: p.ticker,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      returnPct: exit / p.entryPrice - 1,
      holdDays: (Date.parse(end) - Date.parse(p.openedAt)) / DAY_MS,
      open: !p.closedAt,
    });
  }
  const closed = trades.filter((t) => !t.open);
  const sorted = [...trades].sort((a, b) => b.returnPct - a.returnPct);
  return {
    trades: trades.sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
    closed: closed.length,
    winRate: closed.length ? closed.filter((t) => t.returnPct > 0).length / closed.length : null,
    medianHoldDays: median(closed.map((t) => t.holdDays)),
    avgClosedReturn: closed.length ? closed.reduce((s, t) => s + t.returnPct, 0) / closed.length : null,
    best: sorted[0] ?? null,
    worst: sorted.at(-1) ?? null,
  };
}

/** How far a coin had already run in the 30 days before an entry, and how
 * it did after: early buyers show a small "before" and a large "after".
 * Null where the price history doesn't reach. */
export function earlyOrLate(entryAt: string, entryPrice: number, history: ReadonlyMap<string, number> | undefined, currentPrice: number | null): { before30d: number | null; since: number | null } {
  const day = (iso: string, offsetDays: number) => new Date(Date.parse(iso) - offsetDays * DAY_MS).toISOString().slice(0, 10);
  const then = history?.get(day(entryAt, 30));
  return {
    before30d: then && then > 0 ? entryPrice / then - 1 : null,
    since: currentPrice !== null && entryPrice > 0 ? currentPrice / entryPrice - 1 : null,
  };
}

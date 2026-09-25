// Pure logic, no DB, no network — builds the Analytics performance series
// from already-fetched inputs (current holdings, a cached price-history
// map, and the real snapshot rows). History is keyed by each holding's
// price_key, the same one asset it's valued as today; priceHistory.ts
// builds the map and says where each series comes from.

import { parseNumeric, type PostgrestNumeric } from "./valuation.ts";

export interface EstimateHoldingInput {
  ticker: string;
  qty: PostgrestNumeric;
  price_key: string | null;
}

/** Only a CoinGecko coin (a key with no namespace) has fetchable history;
 * jup:/hl:/coinbase: coins build theirs from daily closes only. */
export const isBackfillableKey = (key: string) => !key.includes(":");

/** date (YYYY-MM-DD) -> usd, per price_key — see priceHistory.ts's getPriceHistoryMap. */
export type PriceHistoryMap = Map<string, Map<string, number>>;

/** Merges an asset's stored price layers into one date -> usd map per
 * price_key (later layers win for a day both have): its pre-price_key
 * history rows (`legacyOf`), its own history row, then its daily closes. A
 * key with no layer at all is left out (never fetched). */
export function buildHistoryMap(
  legacyOf: ReadonlyMap<string, ReadonlySet<string>>,
  series: ReadonlyMap<string, Record<string, number>>,
  closes: ReadonlyMap<string, [string, number][]>,
): PriceHistoryMap {
  const map: PriceHistoryMap = new Map();
  for (const [key, legacy] of legacyOf) {
    const layers = [...[...legacy].map((k) => series.get(k)), series.get(key)].filter((l): l is Record<string, number> => !!l);
    const daily = closes.get(key) ?? [];
    if (layers.length === 0 && daily.length === 0) continue;
    const byDate = new Map<string, number>();
    for (const layer of layers) for (const [date, usd] of Object.entries(layer)) byDate.set(date, usd);
    for (const [date, usd] of daily) byDate.set(date, usd);
    map.set(key, byDate);
  }
  return map;
}

export interface SeriesPoint {
  date: string;
  total: number;
}

/**
 * Today's holdings × each one's real historical price, per day — NOT what
 * the portfolio was actually worth (it ignores every past buy/sell), only
 * how today's book would have moved. A holding this can't price for a
 * given day (no key, or no price cached for that day) contributes nothing
 * for that holding on that day — never a guessed or carried-forward value.
 */
export function estimateSeries(
  holdings: EstimateHoldingInput[],
  priceHistory: PriceHistoryMap,
  dates: string[],
): SeriesPoint[] {
  const priced = holdings
    .map((h) => ({ qty: parseNumeric(h.qty), key: h.price_key }))
    .filter((h): h is { qty: number; key: string } => h.qty !== null && h.key !== null);

  return dates.map((date) => {
    let total = 0;
    for (const { qty, key } of priced) {
      const usd = priceHistory.get(key)?.get(date);
      if (usd !== undefined) total += qty * usd;
    }
    return { date, total };
  });
}

export interface CoverageResult {
  coveredUsd: number;
  totalUsd: number;
  pct: number;
  /** No asset at all (a manual dollar-figure holding, a DeFi/LP position
   * with no per-unit market price, an unmapped token), an asset CoinGecko
   * has confirmed has no history (a cached row with an empty series — see
   * priceHistory.ts's 404 handling), or a non-CoinGecko asset (jup:, hl:,
   * coinbase:) with no daily closes yet. Backfilling can't help these. */
  unresolvedUsd: number;
  unresolvedTickers: string[];
  /** A key resolves and has genuinely never been fetched (no row in
   * price_history at all) — either it hasn't been reached by a backfill
   * run yet, or CoinGecko was rate-limited/errored on it last time.
   * Clicking "Backfill history" again can make progress on these; an
   * unresolvedTicker's row already exists (empty), so re-clicking would
   * skip it, not retry it. */
  uncachedUsd: number;
  uncachedTickers: string[];
}

/** What fraction of *today's* current value the estimate above is actually
 * able to price historically — reported, not gated: the chart always
 * renders, this only feeds its caption (see CLAUDE.md's data-correctness
 * rule — always show the number, always state its limits honestly).
 *
 * priceHistory.get(key) is one of three states, not two: undefined (never
 * fetched — a future backfill click helps), an empty Map (fetched, and
 * CoinGecko confirmed it has nothing — permanent, matches unresolved), or
 * a populated Map (covered). Conflating "never fetched" with "confirmed
 * empty" would tell the UI a Backfill click can fix something it can't. */
export function estimateCoverage(
  holdings: (EstimateHoldingInput & { currentUsd: number })[],
  priceHistory: PriceHistoryMap,
  opts: {
    /** The estimate only draws days before this (the first real
     * snapshot): a price only from this day on — a daily close — doesn't
     * cover anything the estimate shows (2026-09-25: today's closes made
     * the caption read 99% when ~80% of value had past prices). */
    before?: string;
    /** Keys with a backfill row (price_history), fetched or confirmed
     * empty; defaults to "has any entry in priceHistory". Daily closes
     * don't count: a coin with only closes can still be backfilled. */
    fetched?: ReadonlySet<string>;
  } = {},
): CoverageResult {
  let coveredUsd = 0;
  let totalUsd = 0;
  let unresolvedUsd = 0;
  let uncachedUsd = 0;
  const unresolved = new Set<string>();
  const uncached = new Set<string>();

  for (const holding of holdings) {
    totalUsd += holding.currentUsd;
    const key = holding.price_key;
    const cached = key === null ? undefined : priceHistory.get(key);
    const hasPast = !!cached && [...cached.keys()].some((date) => opts.before === undefined || date < opts.before);
    const fetched = key !== null && (opts.fetched ? opts.fetched.has(key) : cached !== undefined);

    if (hasPast) {
      coveredUsd += holding.currentUsd;
    } else if (key !== null && isBackfillableKey(key) && !fetched) {
      uncachedUsd += holding.currentUsd;
      uncached.add(holding.ticker);
    } else {
      unresolvedUsd += holding.currentUsd;
      unresolved.add(holding.ticker);
    }
  }

  return {
    coveredUsd,
    totalUsd,
    pct: totalUsd > 0 ? (coveredUsd / totalUsd) * 100 : 0,
    unresolvedUsd,
    unresolvedTickers: [...unresolved],
    uncachedUsd,
    uncachedTickers: [...uncached],
  };
}

export interface StitchedPoint {
  date: string;
  total: number;
  kind: "estimated" | "real";
}

/**
 * Combines the estimated series (pre-history) with the real snapshot
 * series (post-snapshot-table) into one chart-ready series. The seam rule:
 * any date on or after the earliest real snapshot uses real data — either
 * that day's own snapshot, or (if the cron ever misses a day) simply
 * absent, never backfilled with an estimate — and every date before that
 * earliest snapshot uses the estimate. Never blended or averaged — the two
 * numbers measure different things (real past holdings vs. today's
 * holdings at a past price) — and never interleaved: an estimated point
 * can't appear after real snapshots have started, even for a day the cron
 * happened to miss or a token whose backfill window runs past the seam.
 */
export function stitchSeries(estimated: SeriesPoint[], real: SeriesPoint[]): StitchedPoint[] {
  if (real.length === 0) {
    return estimated
      .map((p): StitchedPoint => ({ date: p.date, total: p.total, kind: "estimated" }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  const firstRealDate = real.reduce((min, p) => (p.date < min ? p.date : min), real[0].date);

  const merged: StitchedPoint[] = [
    ...estimated
      .filter((p) => p.date < firstRealDate)
      .map((p): StitchedPoint => ({ date: p.date, total: p.total, kind: "estimated" })),
    ...real.map((p): StitchedPoint => ({ date: p.date, total: p.total, kind: "real" })),
  ];

  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

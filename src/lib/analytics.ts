// Pure logic, no DB, no network — builds the Analytics performance series
// from already-fetched inputs (current holdings, a cached price-history
// map, and the real snapshot rows). See priceKey.ts for how a holding maps
// to the keys used here, and priceHistory.ts for where the price map and
// snapshot rows come from.

import { parseNumeric, type PostgrestNumeric } from "./valuation.ts";
import { resolveCoingeckoKey, type PriceKeyInput } from "./priceKey.ts";

export interface EstimateHoldingInput extends PriceKeyInput {
  qty: PostgrestNumeric;
}

/** date (YYYY-MM-DD) -> usd, per coingecko key — see priceHistory.ts's getPriceHistoryMap. */
export type PriceHistoryMap = Map<string, Map<string, number>>;

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
    .map((h) => ({ qty: parseNumeric(h.qty), key: resolveCoingeckoKey(h) }))
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
  /** No resolvable CoinGecko key at all (a manual dollar-figure holding, a
   * DeFi/LP position with no per-unit market price, a token/chain
   * combination this app has no mapping for) OR a key that resolved but
   * CoinGecko has confirmed has no data (a cached row with an empty
   * series — see priceHistory.ts's 404 handling). Either way, permanent:
   * backfilling again can never help these. */
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
): CoverageResult {
  let coveredUsd = 0;
  let totalUsd = 0;
  let unresolvedUsd = 0;
  let uncachedUsd = 0;
  const unresolved = new Set<string>();
  const uncached = new Set<string>();

  for (const holding of holdings) {
    totalUsd += holding.currentUsd;
    const key = resolveCoingeckoKey(holding);
    const cached = key === null ? undefined : priceHistory.get(key);

    if (cached === undefined && key !== null) {
      uncachedUsd += holding.currentUsd;
      uncached.add(holding.ticker);
    } else if (cached !== undefined && cached.size > 0) {
      coveredUsd += holding.currentUsd;
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

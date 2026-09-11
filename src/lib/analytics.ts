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
  uncoveredTickers: string[];
}

/** What fraction of *today's* current value the estimate above is actually
 * able to price historically — reported, not gated: the chart always
 * renders, this only feeds its caption (see CLAUDE.md's data-correctness
 * rule — always show the number, always state its limits honestly).
 *
 * "Covered" means priceHistory actually has cached rows for the holding's
 * key, not just that a key was resolvable — a key CoinGecko 404s on, or one
 * the backfill hasn't reached/retried yet, resolves fine but has no data,
 * and reporting that as covered would claim more accuracy than the chart
 * actually has for it. */
export function estimateCoverage(
  holdings: (EstimateHoldingInput & { currentUsd: number })[],
  priceHistory: PriceHistoryMap,
): CoverageResult {
  let coveredUsd = 0;
  let totalUsd = 0;
  const uncovered = new Set<string>();

  for (const holding of holdings) {
    totalUsd += holding.currentUsd;
    const key = resolveCoingeckoKey(holding);
    if (key !== null && (priceHistory.get(key)?.size ?? 0) > 0) {
      coveredUsd += holding.currentUsd;
    } else {
      uncovered.add(holding.ticker);
    }
  }

  return {
    coveredUsd,
    totalUsd,
    pct: totalUsd > 0 ? (coveredUsd / totalUsd) * 100 : 0,
    uncoveredTickers: [...uncovered],
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

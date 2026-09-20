// Pure statistics for Trend Finder v2 — no DB, no network, directly
// unit-testable with `node --test`. Replaces the CoinGecko-category-based
// peer ranking in trendFinder.ts (dead code removed alongside this file's
// introduction — see trendPeers.ts).
//
// Why factor-adjusted correlation, not raw correlation: live-verified this
// session against AVAX's real screenshot-reported peers — raw daily
// correlation ranked BTC 3rd and a junk exchange token above DOT (crypto's
// broad market-beta dominates any two random large-cap coins' correlation).
// Regressing out BTC and ETH's own returns first isolates the part of a
// candidate's move that tracks the seed specifically, not "the market was
// up today." Two factors, not one: alt-L1s carry heavy ETH beta on top of
// BTC beta, and a BTC-only residual still clustered everything from DOGE to
// ADA around 0.25-0.28 with no separation — adding ETH as a second factor
// (with the sample sizes below, a free parameter) sharpened that spread.
//
// Why hourly, not daily: 90 days of daily returns is only ~90 observations
// — a 95% CI of roughly ±0.21 on a Pearson estimate, wide enough that ranks
// 4 through 11 in a live 11-candidate test were statistically
// indistinguishable. The same 90-day window at hourly resolution (CoinGecko
// returns hourly-or-finer for days<=90) gives ~2160 observations, ±0.04 —
// enough to cleanly separate real peers (0.25-0.41 in that same live test)
// from noise (0.06-0.07).

/** Every input map is date/hour-keyed (see priceHistory.ts's PriceHistoryMap
 * for the daily equivalent) — intersects every map's key set, since a
 * correlation needs a complete (seed, candidate, factor...) tuple per
 * point, not a padded/forward-filled one. Sorted ascending so consecutive
 * pairs are consecutive time buckets. */
export function alignSeries(...series: Map<string, number>[]): string[] {
  if (series.length === 0) return [];
  let keys = new Set(series[0].keys());
  for (const s of series.slice(1)) {
    keys = new Set([...keys].filter((k) => s.has(k)));
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Log returns between consecutive buckets in `keys` (already sorted, see
 * alignSeries) — one fewer point than `keys`. Log, not simple percent
 * change, so a +50%/-33% round trip nets to zero rather than compounding
 * asymmetrically, which matters when regressing one return series on
 * another. */
export function logReturns(series: Map<string, number>, keys: string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < keys.length; i++) {
    const p0 = series.get(keys[i - 1]);
    const p1 = series.get(keys[i]);
    if (p0 === undefined || p1 === undefined || p0 <= 0 || p1 <= 0) continue;
    out.push(Math.log(p1 / p0));
  }
  return out;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Closed-form two-factor OLS residuals: y = a + b1*f1 + b2*f2 + resid.
 * Used to strip BTC's and ETH's own returns out of a candidate's returns
 * before correlating — see this file's own doc comment for why. Falls back
 * to a single-factor regression if the two factors are collinear (a
 * degenerate 2x2 system, e.g. f1 and f2 identical) rather than dividing by
 * zero. All three arrays must be the same length (same aligned keys). */
export function residualizeTwoFactor(y: number[], f1: number[], f2: number[]): number[] {
  const yc = y.map((v) => v - mean(y));
  const x1 = f1.map((v) => v - mean(f1));
  const x2 = f2.map((v) => v - mean(f2));

  let s11 = 0;
  let s22 = 0;
  let s12 = 0;
  let sy1 = 0;
  let sy2 = 0;
  for (let i = 0; i < yc.length; i++) {
    s11 += x1[i] * x1[i];
    s22 += x2[i] * x2[i];
    s12 += x1[i] * x2[i];
    sy1 += yc[i] * x1[i];
    sy2 += yc[i] * x2[i];
  }

  const det = s11 * s22 - s12 * s12;
  if (det === 0) {
    // Collinear factors — regress on f1 alone (single-factor OLS).
    const b1 = s11 === 0 ? 0 : sy1 / s11;
    return yc.map((v, i) => v - b1 * x1[i]);
  }
  const b1 = (s22 * sy1 - s12 * sy2) / det;
  const b2 = (s11 * sy2 - s12 * sy1) / det;
  return yc.map((v, i) => v - b1 * x1[i] - b2 * x2[i]);
}

/** Pearson correlation coefficient. `null` (never NaN/Infinity) when either
 * series has zero variance — a constant series (e.g. a stablecoin
 * accidentally in the candidate pool) has no meaningful correlation with
 * anything, and this app's own rule is that a missing/undefined value is
 * `null`, never a misleading number (see valuation.ts's doc comment). */
export function pearson(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// Pure dashboard math/logic — no DB, no network. Kept separate from
// queries.ts (which is exclusively "how do I fetch this from Postgres")
// and from the dashboard components themselves, so it can be unit tested
// directly with node --test, same reasoning as valuation.ts.

export interface MoverInput {
  total: number;
  change24h: number | null;
}

export interface BlendedChange {
  usd: number;
  pct: number;
  /** What fraction of total tracked value this blend actually covers —
   * groups with no 24h data are excluded from the average entirely rather
   * than treated as 0% change, so this tells the caller how much of the
   * portfolio that average actually speaks for. */
  coveragePct: number;
}

/**
 * Dollar-weighted average 24h % change across every group that has one —
 * the standard "portfolio daily return" calculation. A group with no
 * change24h (unpriced, or no 24h data available anywhere) is excluded from
 * both the numerator and the weighting denominator, not treated as flat —
 * same "never silently coerce missing data into a number" rule as
 * valuation.ts's aggregate().
 */
export function blendedChange(groups: MoverInput[]): BlendedChange | null {
  let totalValue = 0;
  let coveredValue = 0;
  let weightedUsd = 0;

  for (const g of groups) {
    totalValue += g.total;
    if (g.change24h === null) continue;
    coveredValue += g.total;
    weightedUsd += g.total * (g.change24h / 100);
  }

  if (coveredValue === 0) return null;
  return {
    usd: weightedUsd,
    pct: (weightedUsd / coveredValue) * 100,
    coveragePct: totalValue === 0 ? 0 : (coveredValue / totalValue) * 100,
  };
}

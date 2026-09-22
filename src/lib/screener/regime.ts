// Pure market-regime label (Phase 2a) — see regime.test.ts. Every rule is
// three-valued (Kleene logic): true, false, or null = not evaluable because
// a deciding input is unknown. Only a rule that is definitely true can set
// the label (a null input never fires — absence of data isn't evidence),
// and every rule's outcome + inputs are stored next to the label, so the
// label is never a black box (build prompt: "always show the inputs").

import { SCREENER_CONFIG, type ScreenerConfig } from "./config.ts";

export type RegimeLabel = "RISK_OFF" | "BTC_LED" | "ROTATION" | "FROTH" | "NEUTRAL";

export interface RegimeInputs {
  btcDominancePct: number | null;
  btcDominance4wChangePts: number | null;
  ethBtc4wChangePct: number | null;
  stablecoinSupply30dChangePct: number | null;
  /** Percentile (0-1) of today's avg BTC/ETH funding within our stored history. */
  fundingPercentile: number | null;
  btcOi4wChangePct: number | null;
  btcPrice4wChangePct: number | null;
}

export interface RuleOutcome {
  rule: Exclude<RegimeLabel, "NEUTRAL">;
  fired: boolean | null;
  inputs: Record<string, number | null>;
}

type Tri = boolean | null;
const cmp = (v: number | null, test: (x: number) => boolean): Tri => (v === null ? null : test(v));
const and = (...xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or = (...xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);

export function evaluateRegime(i: RegimeInputs, config: ScreenerConfig = SCREENER_CONFIG): { label: RegimeLabel; rules: RuleOutcome[] } {
  const r = config.regime;
  const oiMinusPrice = diff(i.btcOi4wChangePct, i.btcPrice4wChangePct);

  const rules: RuleOutcome[] = [
    {
      // funding in the top decile of stored history OR OI rising much faster than price
      rule: "FROTH",
      fired: or(
        cmp(i.fundingPercentile, (x) => x >= r.frothFundingPercentile),
        cmp(oiMinusPrice, (x) => x > r.frothOiMinusPriceChangePts),
      ),
      inputs: { fundingPercentile: i.fundingPercentile, btcOi4wChangePct: i.btcOi4wChangePct, btcPrice4wChangePct: i.btcPrice4wChangePct },
    },
    {
      // stablecoin supply shrinking AND BTC dominance rising
      rule: "RISK_OFF",
      fired: and(
        cmp(i.stablecoinSupply30dChangePct, (x) => x < 0),
        cmp(i.btcDominance4wChangePts, (x) => x > r.flatDominanceBandPts),
      ),
      inputs: { stablecoinSupply30dChangePct: i.stablecoinSupply30dChangePct, btcDominance4wChangePts: i.btcDominance4wChangePts },
    },
    {
      // BTC dominance falling hard AND ETH/BTC rising
      rule: "ROTATION",
      fired: and(
        cmp(i.btcDominance4wChangePts, (x) => x < -r.rotationDominanceDropPts),
        cmp(i.ethBtc4wChangePct, (x) => x > 0),
      ),
      inputs: { btcDominance4wChangePts: i.btcDominance4wChangePts, ethBtc4wChangePct: i.ethBtc4wChangePct },
    },
    {
      // high and flat/rising BTC dominance, flat stablecoin supply
      rule: "BTC_LED",
      fired: and(
        cmp(i.btcDominancePct, (x) => x > r.btcLedDominanceAbovePct),
        cmp(i.btcDominance4wChangePts, (x) => x >= -r.flatDominanceBandPts),
        cmp(i.stablecoinSupply30dChangePct, (x) => Math.abs(x) < r.flatStablecoinBandPct),
      ),
      inputs: {
        btcDominancePct: i.btcDominancePct,
        btcDominance4wChangePts: i.btcDominance4wChangePts,
        stablecoinSupply30dChangePct: i.stablecoinSupply30dChangePct,
      },
    },
  ];

  const byRule = new Map(rules.map((x) => [x.rule, x.fired]));
  const label = (r.precedence as readonly RuleOutcome["rule"][]).find((name) => byRule.get(name) === true) ?? "NEUTRAL";
  return { label, rules };
}

/** Fraction (0-1) of `history` values strictly below `value`; null when the
 * history is shorter than `minPoints` (too little to call anything a decile). */
export function percentileOf(value: number | null, history: readonly number[], minPoints: number): number | null {
  if (value === null || history.length < minPoints) return null;
  return history.filter((h) => h < value).length / history.length;
}

/** One value per UTC day (the latest-computed row that day wins), in date
 * order. The funding percentile must compare against days, not runs — a
 * manual re-run or an extra cron trigger on the same day would otherwise
 * count that day twice. */
export function oneValuePerDay(rows: readonly { computed_at: string; value: number | null }[]): number[] {
  const byDay = new Map<string, { at: string; value: number }>();
  for (const r of rows) {
    if (r.value === null) continue;
    const day = r.computed_at.slice(0, 10);
    const current = byDay.get(day);
    if (!current || r.computed_at > current.at) byDay.set(day, { at: r.computed_at, value: r.value });
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v.value);
}

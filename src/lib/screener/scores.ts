// Pure Phase 3 scoring for one live run's rated assets — see scores.test.ts.
// Three separate outputs, deliberately not blended:
// - Quality & Risk TIER (pass / caution / high_risk): filters and flags, never
//   a score. Worst tier wins; a rule with a null input doesn't fire (absence
//   of data isn't evidence of risk), and every rule's outcome + input is kept
//   so the tier is never a black box.
// - Score B (momentum, the primary ranking): mean of the two momentum legs'
//   percentile ranks, then its own percentile, graded A–F. High risk caps the
//   displayed grade at C; the raw grade is kept.
// - Setup tag: tier × momentum tercile (the 3×3 grid in SPEC).
// Ranking population = FULL-HISTORY assets (both momentum legs present).
// An asset with one leg is "insufficient history": averaging two percentile
// ranks compresses variance, so a one-leg score keeps the full 0–1 range
// and would land at the extremes by construction. It gets a score and a
// percentile placed against the full-history distribution, but no grade,
// tercile or tag. Only rated assets are scored — an unrated asset's reason
// is its gate_status. Null is never 0: no legs means no score at all.

import { SCREENER_CONFIG, type ScreenerConfig } from "./config.ts";
import type { RegimeLabel } from "./regime.ts";

export type Tier = "pass" | "caution" | "high_risk";
export type Grade = "A" | "B" | "C" | "D" | "F";
export type SetupTag = "LEADER" | "WATCH" | "SPECULATIVE" | "AVOID" | "NEUTRAL";
export type Confidence = "high" | "medium" | "low";
export type SizeBucket = "small" | "mid" | "large";
export type Tercile = 1 | 2 | 3; // 1 = top third

export interface ScoreInput {
  asset_id: string;
  mom_3w: number | null;
  mom_12w: number | null;
  beta_btc: number | null;
  rev_90d_change: number | null;
  /** MEASURED dilution only (live supply) — never dilution_rate_implied. */
  dilution_rate: number | null;
  /** Next-90d unlocks as a share of circulating. No source exists yet
   * (screener_manual_unlocks deferred), so always null for now. */
  unlocks_90d_pct_circulating: number | null;
  market_cap_usd: number | null;
  /** A flagged source conflict on this asset's price or market cap this run. */
  has_source_conflict: boolean;
}

export interface TierRule {
  rule: "dilution_high" | "unlocks_90d" | "revenue_90d_drop" | "dilution_caution";
  tier: Exclude<Tier, "pass">;
  fired: boolean | null;
  input: number | null;
  threshold: number;
}

export interface AssetScore {
  asset_id: string;
  quality_risk_tier: Tier;
  quality_risk_rules: TierRule[];
  rules_evaluable: number;
  timing_score: number | null;
  timing_percentile: number | null;
  timing_grade_raw: Grade | null;
  timing_grade: Grade | null;
  momentum_tercile: Tercile | null;
  setup_tag: SetupTag | null;
  confidence: Confidence;
  size_bucket: SizeBucket | null;
  score_breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  legs: Record<string, { value: number | null; percentile: number | null }>;
  legs_used: number;
  /** One momentum leg only: scored and placed, but not graded/tagged. */
  insufficient_history: boolean;
  base_score: number | null;
  regime: { label: RegimeLabel | null; beta_penalty: number; beta_percentile: number | null; adjustment: number };
  source_conflict: boolean;
}

export interface SizeCheck {
  top_tercile_n: number;
  counts: Record<SizeBucket, number>;
  dominant: SizeBucket | null;
  share: number | null;
  flagged: boolean;
}

export interface RunScores {
  scores: AssetScore[];
  size_check: SizeCheck;
  counts: { full_history: number; insufficient_history: number; unscored: number; tiers: Record<Tier, number>; tags: Record<string, number>; grades: Record<string, number> };
  warnings: string[];
}

const above = (v: number | null, t: number): boolean | null => (v === null ? null : v > t);
const below = (v: number | null, t: number): boolean | null => (v === null ? null : v < t);

export function evaluateTier(i: ScoreInput, config: ScreenerConfig = SCREENER_CONFIG): { tier: Tier; rules: TierRule[] } {
  const hr = config.tiers.highRisk;
  const rules: TierRule[] = [
    { rule: "dilution_high", tier: "high_risk", input: i.dilution_rate, threshold: hr.dilutionRateAbove, fired: above(i.dilution_rate, hr.dilutionRateAbove) },
    {
      rule: "unlocks_90d",
      tier: "high_risk",
      input: i.unlocks_90d_pct_circulating,
      threshold: hr.unlocks90dPctOfCirculatingAbove,
      fired: above(i.unlocks_90d_pct_circulating, hr.unlocks90dPctOfCirculatingAbove),
    },
    { rule: "revenue_90d_drop", tier: "high_risk", input: i.rev_90d_change, threshold: hr.revenue90dChangeBelow, fired: below(i.rev_90d_change, hr.revenue90dChangeBelow) },
    {
      rule: "dilution_caution",
      tier: "caution",
      input: i.dilution_rate,
      threshold: config.tiers.caution.dilutionRateAbove,
      fired: above(i.dilution_rate, config.tiers.caution.dilutionRateAbove),
    },
  ];
  const tier: Tier = rules.some((r) => r.tier === "high_risk" && r.fired === true)
    ? "high_risk"
    : rules.some((r) => r.tier === "caution" && r.fired === true)
      ? "caution"
      : "pass";
  return { tier, rules };
}

/** Mid-rank percentile in (0, 1) of each value among the non-null values:
 * (count below + half the count equal) / n. Ties share a percentile; null
 * stays null. */
export function percentileRanks(values: readonly (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const n = present.length;
  return values.map((v) => {
    if (v === null) return null;
    let lo = 0;
    while (lo < n && present[lo] < v) lo++;
    let hi = lo;
    while (hi < n && present[hi] === v) hi++;
    return (lo + 0.5 * (hi - lo)) / n;
  });
}

export function gradeFor(percentile: number, config: ScreenerConfig = SCREENER_CONFIG): Grade {
  for (const c of config.scoring.gradeCutoffs) if (percentile >= c.minPercentile) return c.grade as Grade;
  return "F";
}

const GRADE_ORDER: Grade[] = ["A", "B", "C", "D", "F"];

/** The worse of `grade` and `cap` (a C cap turns A/B into C, leaves D/F). */
export function capGrade(grade: Grade, cap: Grade): Grade {
  return GRADE_ORDER.indexOf(grade) < GRADE_ORDER.indexOf(cap) ? cap : grade;
}

export function tercileFor(percentile: number): Tercile {
  return percentile >= 2 / 3 ? 1 : percentile >= 1 / 3 ? 2 : 3;
}

const TAG_GRID: Record<Tier, Record<Tercile, SetupTag>> = {
  pass: { 1: "LEADER", 2: "NEUTRAL", 3: "WATCH" },
  caution: { 1: "SPECULATIVE", 2: "NEUTRAL", 3: "NEUTRAL" },
  high_risk: { 1: "SPECULATIVE", 2: "NEUTRAL", 3: "AVOID" },
};

export function setupTag(tier: Tier, tercile: Tercile): SetupTag {
  return TAG_GRID[tier][tercile];
}

export function confidenceFor(legsUsed: number, hasConflict: boolean): Confidence {
  const gaps = (legsUsed < 2 ? 1 : 0) + (hasConflict ? 1 : 0);
  return legsUsed === 0 || gaps === 2 ? "low" : gaps === 1 ? "medium" : "high";
}

export function sizeBucketFor(mcap: number | null, config: ScreenerConfig = SCREENER_CONFIG): SizeBucket | null {
  if (mcap === null) return null;
  const b = config.scoring.sizeBuckets;
  return mcap >= b.largeFromUsd ? "large" : mcap >= b.midFromUsd ? "mid" : "small";
}

export function checkSize(scores: readonly AssetScore[], config: ScreenerConfig = SCREENER_CONFIG): SizeCheck {
  const top = scores.filter((s) => s.momentum_tercile === 1 && s.size_bucket !== null);
  const counts: Record<SizeBucket, number> = { small: 0, mid: 0, large: 0 };
  for (const s of top) counts[s.size_bucket!]++;
  if (top.length === 0) return { top_tercile_n: 0, counts, dominant: null, share: null, flagged: false };
  const [dominant, n] = (Object.entries(counts) as [SizeBucket, number][]).reduce((a, b) => (b[1] > a[1] ? b : a));
  const share = n / top.length;
  return { top_tercile_n: top.length, counts, dominant, share, flagged: share > config.scoring.sizeCheckTopTercileShareAbove };
}

/** Mid-rank percentile of `value` placed into `population` (as if it were
 * one more member): (count below + half of (equal + itself)) / (n + 1).
 * For a population member, percentileRanks gives the same thing. */
export function placeAgainst(value: number, population: readonly number[]): number {
  const below = population.filter((v) => v < value).length;
  const equal = population.filter((v) => v === value).length;
  return (below + 0.5 * (equal + 1)) / (population.length + 1);
}

/** Scores every rated asset of one run. `inputs` must be the rated set only.
 * Every percentile (legs, beta, Score B) is ranked among the full-history
 * assets; an insufficient-history asset's values are placed against them. */
export function scoreRun(inputs: readonly ScoreInput[], regimeLabel: RegimeLabel | null, config: ScreenerConfig = SCREENER_CONFIG): RunScores {
  const legs = config.scoring.momentumLegs as readonly ("mom_3w" | "mom_12w")[];
  const legsPresent = (i: ScoreInput) => legs.filter((leg) => i[leg] !== null).length;
  const full = inputs.filter((i) => legsPresent(i) === legs.length);

  /** Percentile of one asset's value of `field` among the full-history set. */
  const pctIn = (field: "mom_3w" | "mom_12w" | "beta_btc") => {
    const population = full.map((i) => i[field]).filter((v): v is number => v !== null);
    const ranks = percentileRanks(full.map((f) => f[field]));
    const own = new Map(full.map((i, idx) => [i.asset_id, ranks[idx]]));
    return (i: ScoreInput): number | null =>
      i[field] === null ? null : own.has(i.asset_id) ? own.get(i.asset_id)! : placeAgainst(i[field]!, population);
  };
  const legPct = new Map(legs.map((leg) => [leg, pctIn(leg)]));
  const betaPct = pctIn("beta_btc");
  const modifiers = config.scoring.regimeModifiers as Record<string, { betaPenalty: number }>;
  const betaPenalty = regimeLabel ? (modifiers[regimeLabel]?.betaPenalty ?? 0) : 0;

  const partial = inputs.map((input) => {
    const legBreakdown: ScoreBreakdown["legs"] = {};
    const used: number[] = [];
    for (const leg of legs) {
      const p = legPct.get(leg)!(input);
      legBreakdown[leg] = { value: input[leg], percentile: p };
      if (p !== null) used.push(p);
    }
    const base = used.length > 0 ? used.reduce((a, b) => a + b, 0) / used.length : null;
    const bp = betaPct(input);
    // Applied only when there's a penalty AND a beta to apply it to; a null
    // beta under a non-zero penalty leaves the base score as is (recorded).
    const adjustment = betaPenalty !== 0 && bp !== null ? -betaPenalty * (bp - 0.5) : 0;
    return {
      input,
      used: used.length,
      isFull: used.length === legs.length,
      score: base === null ? null : base + adjustment,
      breakdown: {
        legs: legBreakdown,
        legs_used: used.length,
        insufficient_history: used.length > 0 && used.length < legs.length,
        base_score: base,
        regime: { label: regimeLabel, beta_penalty: betaPenalty, beta_percentile: bp, adjustment },
        source_conflict: input.has_source_conflict,
      } satisfies ScoreBreakdown,
    };
  });

  const fullPartial = partial.filter((p) => p.isFull);
  const fullScores = fullPartial.map((p) => p.score!);
  const fullRanks = percentileRanks(fullScores);
  const fullPct = new Map(fullPartial.map((p, idx) => [p.input.asset_id, fullRanks[idx]!]));
  const cap = config.scoring.highRiskGradeCap as Grade;
  const scores: AssetScore[] = partial.map((p) => {
    const { tier, rules } = evaluateTier(p.input, config);
    const pct = p.score === null ? null : p.isFull ? fullPct.get(p.input.asset_id)! : placeAgainst(p.score, fullScores);
    // Grade, tercile and tag only for full-history assets.
    const raw = p.isFull ? gradeFor(pct!, config) : null;
    const tercile = p.isFull ? tercileFor(pct!) : null;
    return {
      asset_id: p.input.asset_id,
      quality_risk_tier: tier,
      quality_risk_rules: rules,
      rules_evaluable: rules.filter((r) => r.fired !== null).length,
      timing_score: p.score,
      timing_percentile: pct,
      timing_grade_raw: raw,
      timing_grade: raw === null ? null : tier === "high_risk" ? capGrade(raw, cap) : raw,
      momentum_tercile: tercile,
      setup_tag: tercile === null ? null : setupTag(tier, tercile),
      confidence: confidenceFor(p.used, p.input.has_source_conflict),
      size_bucket: sizeBucketFor(p.input.market_cap_usd, config),
      score_breakdown: p.breakdown,
    };
  });

  const tally = <K extends string>(keys: (K | null)[]) => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k ?? "none"] = (out[k ?? "none"] ?? 0) + 1;
    return out;
  };
  const graded = scores.filter((s) => s.momentum_tercile !== null);
  const tiers: Record<Tier, number> = { pass: 0, caution: 0, high_risk: 0 };
  for (const s of scores) tiers[s.quality_risk_tier]++;

  // Checks on the output's shape — by construction these can only fail on a
  // bug (same spirit as plausibility.ts: report, never silently write).
  const warnings: string[] = [];
  for (const s of scores) {
    const legsUsed = s.score_breakdown.legs_used;
    if ((legsUsed > 0) !== (s.timing_score !== null)) warnings.push(`${s.asset_id}: ${legsUsed} momentum legs but scored = ${s.timing_score !== null}`);
    if ((legsUsed === legs.length) !== (s.setup_tag !== null)) warnings.push(`${s.asset_id}: ${legsUsed} momentum legs but tagged = ${s.setup_tag !== null}`);
  }
  if (graded.length >= 9) {
    for (const t of [1, 2, 3] as Tercile[]) {
      const share = graded.filter((s) => s.momentum_tercile === t).length / graded.length;
      if (share < 0.25 || share > 0.42) warnings.push(`tercile ${t} holds ${(share * 100).toFixed(0)}% of graded assets (expected ~33%)`);
    }
  }

  return {
    scores,
    size_check: checkSize(scores, config),
    counts: {
      full_history: graded.length,
      insufficient_history: scores.filter((s) => s.score_breakdown.insufficient_history).length,
      unscored: scores.filter((s) => s.timing_score === null).length,
      tiers,
      tags: tally(scores.map((s) => s.setup_tag)),
      grades: tally(scores.map((s) => s.timing_grade)),
    },
    warnings,
  };
}

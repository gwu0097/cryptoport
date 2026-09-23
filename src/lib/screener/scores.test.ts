import test from "node:test";
import assert from "node:assert/strict";
import { SCREENER_CONFIG } from "./config.ts";
import {
  evaluateTier,
  percentileRanks,
  gradeFor,
  capGrade,
  tercileFor,
  setupTag,
  confidenceFor,
  sizeBucketFor,
  scoreRun,
  placeAgainst,
  type ScoreInput,
  type Tier,
  type Tercile,
} from "./scores.ts";

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  asset_id: "a",
  mom_3w: 0.1,
  mom_12w: 0.2,
  beta_btc: 1,
  rev_90d_change: 0.1,
  dilution_rate: null,
  unlocks_90d_pct_circulating: null,
  market_cap_usd: 500_000_000,
  has_source_conflict: false,
  ...over,
});

test("tier: every rule null -> pass with 0 of 4 evaluable (absence of data is not risk)", () => {
  const { tier, rules } = evaluateTier(input({ rev_90d_change: null }));
  assert.equal(tier, "pass");
  assert.equal(rules.length, 4);
  assert.ok(rules.every((r) => r.fired === null));
});

test("tier: revenue down >40% -> high_risk; exactly -40% does not fire", () => {
  assert.equal(evaluateTier(input({ rev_90d_change: -0.41 })).tier, "high_risk");
  assert.equal(evaluateTier(input({ rev_90d_change: -0.4 })).tier, "pass");
});

test("tier: measured dilution 10-25% -> caution, >25% -> high_risk; worst tier wins and every fired rule is kept", () => {
  assert.equal(evaluateTier(input({ dilution_rate: 0.15 })).tier, "caution");
  const { tier, rules } = evaluateTier(input({ dilution_rate: 0.3, rev_90d_change: -0.5 }));
  assert.equal(tier, "high_risk");
  assert.deepEqual(rules.filter((r) => r.fired).map((r) => r.rule).sort(), ["dilution_caution", "dilution_high", "revenue_90d_drop"]);
});

test("tier: unlock rule only fires on real data", () => {
  assert.equal(evaluateTier(input({ unlocks_90d_pct_circulating: 0.06 })).tier, "high_risk");
  assert.equal(evaluateTier(input({ unlocks_90d_pct_circulating: 0.04 })).tier, "pass");
});

test("percentileRanks: mid-rank, ties share a value, nulls stay null", () => {
  assert.deepEqual(percentileRanks([10, null, 30, 20]), [1 / 6, null, 5 / 6, 3 / 6]);
  const tied = percentileRanks([1, 2, 2, 3]);
  assert.equal(tied[1], tied[2]);
  assert.equal(tied[1], 0.5);
  assert.deepEqual(percentileRanks([null, null]), [null, null]);
  assert.deepEqual(percentileRanks([7]), [0.5]);
});

test("grade cutoffs 80/60/40/20 at their exact edges", () => {
  assert.equal(gradeFor(0.8), "A");
  assert.equal(gradeFor(0.7999), "B");
  assert.equal(gradeFor(0.6), "B");
  assert.equal(gradeFor(0.4), "C");
  assert.equal(gradeFor(0.2), "D");
  assert.equal(gradeFor(0.1999), "F");
  assert.equal(SCREENER_CONFIG.scoring.validated, false);
});

test("capGrade: a C cap lowers A/B to C and leaves C/D/F alone", () => {
  assert.deepEqual((["A", "B", "C", "D", "F"] as const).map((g) => capGrade(g, "C")), ["C", "C", "C", "D", "F"]);
});

test("terciles at their edges", () => {
  assert.equal(tercileFor(2 / 3), 1);
  assert.equal(tercileFor(0.6666), 2);
  assert.equal(tercileFor(1 / 3), 2);
  assert.equal(tercileFor(0.3333), 3);
});

test("setup tag: all nine cells of the grid", () => {
  const expected: Record<Tier, [string, string, string]> = {
    pass: ["LEADER", "NEUTRAL", "WATCH"],
    caution: ["SPECULATIVE", "NEUTRAL", "NEUTRAL"],
    high_risk: ["SPECULATIVE", "NEUTRAL", "AVOID"],
  };
  for (const tier of Object.keys(expected) as Tier[]) {
    for (const t of [1, 2, 3] as Tercile[]) assert.equal(setupTag(tier, t), expected[tier][t - 1], `${tier} × tercile ${t}`);
  }
});

test("confidence: both legs + no conflict high; one gap medium; both gaps or no legs low", () => {
  assert.equal(confidenceFor(2, false), "high");
  assert.equal(confidenceFor(1, false), "medium");
  assert.equal(confidenceFor(2, true), "medium");
  assert.equal(confidenceFor(1, true), "low");
  assert.equal(confidenceFor(0, false), "low");
});

test("size buckets", () => {
  assert.equal(sizeBucketFor(99_999_999), "small");
  assert.equal(sizeBucketFor(100_000_000), "mid");
  assert.equal(sizeBucketFor(1_000_000_000), "large");
  assert.equal(sizeBucketFor(null), null);
});

/** n assets with strictly increasing momentum on both legs. */
const ladder = (n: number, over: (i: number) => Partial<ScoreInput> = () => ({})) =>
  Array.from({ length: n }, (_, i) => input({ asset_id: `a${i}`, mom_3w: i, mom_12w: i, ...over(i) }));

test("scoreRun: score = mean of the legs' percentiles; the best asset is an A LEADER, the worst an F WATCH", () => {
  const { scores, warnings } = scoreRun(ladder(10), "NEUTRAL");
  const best = scores.find((s) => s.asset_id === "a9")!;
  const worst = scores.find((s) => s.asset_id === "a0")!;
  assert.equal(best.timing_score, 0.95);
  assert.equal(best.timing_grade, "A");
  assert.equal(best.setup_tag, "LEADER");
  assert.equal(worst.timing_grade, "F");
  assert.equal(worst.setup_tag, "WATCH");
  assert.deepEqual(warnings, []);
});

test("scoreRun: High risk caps the displayed grade at C and keeps the raw grade auditable", () => {
  const { scores } = scoreRun(ladder(10, (i) => (i === 9 ? { rev_90d_change: -0.5 } : {})), "NEUTRAL");
  const capped = scores.find((s) => s.asset_id === "a9")!;
  assert.equal(capped.quality_risk_tier, "high_risk");
  assert.equal(capped.timing_grade_raw, "A");
  assert.equal(capped.timing_grade, "C");
  assert.equal(capped.setup_tag, "SPECULATIVE", "top tercile + high risk");
});

test("scoreRun: Caution never caps a grade", () => {
  const { scores } = scoreRun(ladder(10, (i) => (i === 9 ? { dilution_rate: 0.15 } : {})), "NEUTRAL");
  const s = scores.find((x) => x.asset_id === "a9")!;
  assert.equal(s.quality_risk_tier, "caution");
  assert.equal(s.timing_grade, "A");
});

test("placeAgainst: mid-rank as if one more member of the population", () => {
  assert.equal(placeAgainst(10, [1, 2, 3]), 3.5 / 4, "above everyone");
  assert.equal(placeAgainst(0, [1, 2, 3]), 0.5 / 4, "below everyone");
  assert.equal(placeAgainst(2, [1, 2, 3]), (1 + 0.5 * 2) / 4, "tied with one member");
  // Agrees with percentileRanks for a real member.
  assert.equal(placeAgainst(2, [1, 3]), percentileRanks([1, 2, 3])[1]);
});

test("scoreRun: one leg = insufficient history — scored and placed, but no grade, tercile or tag", () => {
  const rows = [...ladder(6), input({ asset_id: "one", mom_3w: 100, mom_12w: null }), input({ asset_id: "none", mom_3w: null, mom_12w: null })];
  const { scores, counts, warnings } = scoreRun(rows, "NEUTRAL");
  const one = scores.find((s) => s.asset_id === "one")!;
  assert.equal(one.score_breakdown.legs_used, 1);
  assert.equal(one.score_breakdown.insufficient_history, true);
  assert.equal(one.score_breakdown.legs.mom_3w.percentile, 6.5 / 7, "its leg is placed against the 6 full-history values");
  assert.equal(one.timing_score, 6.5 / 7);
  assert.equal(one.timing_percentile, placeAgainst(6.5 / 7, scores.filter((s) => s.momentum_tercile !== null).map((s) => s.timing_score!)));
  assert.equal(one.timing_grade_raw, null);
  assert.equal(one.timing_grade, null);
  assert.equal(one.momentum_tercile, null);
  assert.equal(one.setup_tag, null);
  assert.equal(one.confidence, "medium");
  const none = scores.find((s) => s.asset_id === "none")!;
  assert.equal(none.timing_score, null);
  assert.equal(none.timing_percentile, null);
  assert.equal(none.setup_tag, null);
  assert.equal(none.confidence, "low");
  assert.equal(none.quality_risk_tier, "pass", "the tier is still evaluated without momentum");
  assert.deepEqual({ full: counts.full_history, insufficient: counts.insufficient_history, unscored: counts.unscored }, { full: 6, insufficient: 1, unscored: 1 });
  assert.deepEqual(warnings, []);
});

test("scoreRun: an insufficient-history asset doesn't move the full-history ranking", () => {
  const without = scoreRun(ladder(9), null).scores;
  const withOne = scoreRun([...ladder(9), input({ asset_id: "extreme", mom_3w: 1e6, mom_12w: null })], null).scores;
  for (const s of without) {
    const t = withOne.find((x) => x.asset_id === s.asset_id)!;
    assert.equal(t.timing_score, s.timing_score);
    assert.equal(t.timing_percentile, s.timing_percentile);
    assert.equal(t.setup_tag, s.setup_tag);
  }
});

test("scoreRun: ties at a tercile edge land in the same tercile", () => {
  const rows = ladder(9).map((r, i) => (i >= 5 && i <= 6 ? { ...r, mom_3w: 5, mom_12w: 5 } : r));
  const { scores } = scoreRun(rows, null);
  const a5 = scores.find((s) => s.asset_id === "a5")!;
  const a6 = scores.find((s) => s.asset_id === "a6")!;
  assert.equal(a5.timing_percentile, a6.timing_percentile);
  assert.equal(a5.momentum_tercile, a6.momentum_tercile);
});

test("scoreRun: regime modifiers are 0 in the shipped config — the label changes nothing", () => {
  const a = scoreRun(ladder(10), "RISK_OFF").scores.map((s) => s.timing_score);
  const b = scoreRun(ladder(10), "NEUTRAL").scores.map((s) => s.timing_score);
  assert.deepEqual(a, b);
});

test("scoreRun: a non-zero modifier pushes high-beta assets down in that regime", () => {
  const config = {
    ...SCREENER_CONFIG,
    scoring: { ...SCREENER_CONFIG.scoring, regimeModifiers: { ...SCREENER_CONFIG.scoring.regimeModifiers, RISK_OFF: { betaPenalty: 0.5, evidence_ref: "test" } } },
  } as unknown as typeof SCREENER_CONFIG;
  // Same momentum for all; beta rising with index.
  const rows = Array.from({ length: 4 }, (_, i) => input({ asset_id: `b${i}`, mom_3w: 1, mom_12w: 1, beta_btc: i }));
  const { scores } = scoreRun(rows, "RISK_OFF", config);
  assert.ok(scores[0].timing_score! > scores[3].timing_score!);
  assert.equal(scores[3].score_breakdown.regime.adjustment, -0.5 * (7 / 8 - 0.5));
});

test("size check flags a top tercile dominated by one market-cap bucket", () => {
  const small = scoreRun(ladder(9, () => ({ market_cap_usd: 20_000_000 })), null).size_check;
  assert.equal(small.top_tercile_n, 3);
  assert.equal(small.dominant, "small");
  assert.equal(small.flagged, true);
  const mixed = scoreRun(ladder(9, (i) => ({ market_cap_usd: [20e6, 200e6, 2e9][i % 3] })), null).size_check;
  assert.equal(mixed.flagged, false);
});

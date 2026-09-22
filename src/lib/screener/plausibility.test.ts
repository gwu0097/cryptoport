import test from "node:test";
import assert from "node:assert/strict";
import { checkPlausibility, median } from "./plausibility.ts";

const rows = (betas: number[], extra: Record<string, unknown> = {}) =>
  betas.map((beta_btc) => ({ rated: true, beta_btc, mom_3w: 0.1, mom_12w: 0.1, rev_90d_change: 0.1, capture: 0.5, float_ratio: 0.5, ...extra }));

test("median handles odd/even lengths and empty input", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("the first-2b-run failure mode (median beta 0.07) is flagged", () => {
  const w = checkPlausibility(rows([0.02, 0.07, 0.1]));
  assert.deepEqual(w.map((x) => [x.metric, x.kind]), [["beta_btc", "median"]]);
  assert.equal(w[0].value, 0.07);
});

test("a plausible run produces no warnings", () => {
  assert.deepEqual(checkPlausibility(rows([0.8, 1.1, 1.4])), []);
});

test("unrated assets and nulls don't count toward the median", () => {
  const r = [...rows([1.0, 1.2]), { rated: false, beta_btc: 0.01 }, { rated: true, beta_btc: null }];
  assert.deepEqual(checkPlausibility(r), []);
});

test("per-asset bounds: capture above 1 is impossible and flagged by count", () => {
  const w = checkPlausibility(rows([1, 1, 1], { capture: 1.42 }));
  assert.deepEqual(w.map((x) => [x.metric, x.kind, x.value]), [["capture", "per_asset", 3]]);
});

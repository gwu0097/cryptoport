import test from "node:test";
import assert from "node:assert/strict";
import { averageRanks, pearson, spearman, tQuantile975, summarize, tercileSpread, olsResiduals, heldBackThird } from "./backtestStats.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("averageRanks: 1-based, ties share the average of their ranks", () => {
  assert.deepEqual(averageRanks([10, 30, 20]), [1, 3, 2]);
  assert.deepEqual(averageRanks([5, 1, 5, 3]), [3.5, 1, 3.5, 2]);
});

test("spearman = Pearson of ranks; perfect monotone = 1, reversed = -1, constant = null", () => {
  close(spearman([1, 2, 3, 4], [10, 20, 35, 1000])!, 1);
  close(spearman([1, 2, 3, 4], [4, 3, 2, 1])!, -1);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  // A textbook value with a tie: x = [1,2,2,4], y = [1,3,2,4] -> ranks x [1,2.5,2.5,4], y [1,3,2,4]
  close(spearman([1, 2, 2, 4], [1, 3, 2, 4])!, pearson([1, 2.5, 2.5, 4], [1, 3, 2, 4])!);
});

test("t quantiles match published tables", () => {
  close(tQuantile975(2), 4.3027, 1e-3);
  close(tQuantile975(8), 2.3060, 1e-3);
  close(tQuantile975(23), 2.0687, 1e-3);
  close(tQuantile975(35), 2.0301, 1e-3);
});

test("summarize: mean, sample sd, t, and the t-based 95% CI", () => {
  const s = summarize([0.1, 0.2, 0.3])!;
  close(s.mean, 0.2);
  close(s.sd, 0.1);
  close(s.t, 0.2 / (0.1 / Math.sqrt(3)));
  close(s.ci[0], 0.2 - tQuantile975(2) * 0.1 / Math.sqrt(3));
  assert.equal(summarize([1]), null);
});

test("tercileSpread: sort by factor desc, ties by id asc, top/bottom ceil(n/3) positions", () => {
  const rows = [
    { id: "a", factor: 5, ret: 0.1 },
    { id: "b", factor: 4, ret: 0.2 },
    { id: "c", factor: 3, ret: 0.0 },
    { id: "d", factor: 2, ret: -0.1 },
    { id: "e", factor: 1, ret: -0.3 },
  ];
  // n=5 -> k=2: top a,b (0.15) minus bottom d,e (-0.2) = 0.35
  close(tercileSpread(rows)!, 0.35);
  const tied = [
    { id: "z", factor: 1, ret: 1 },
    { id: "y", factor: 1, ret: 0 },
    { id: "x", factor: 1, ret: -1 },
  ];
  // all tied: order x,y,z by id; top = x (-1), bottom = z (1) -> -2
  close(tercileSpread(tied)!, -2);
});

test("olsResiduals: removes the part of y explained by x (with intercept)", () => {
  const x = [1, 2, 3, 4, 5];
  const y = x.map((v) => 3 + 2 * v);
  for (const r of olsResiduals(y, [x])) close(r, 0, 1e-9);
  const noisy = [1, 3, 2, 5, 4];
  const res = olsResiduals(noisy, [x]);
  close(res.reduce((a, b) => a + b, 0), 0, 1e-9); // residuals sum to 0 with an intercept
  close(pearson(res, x) ?? 0, 0, 1e-9); // and are uncorrelated with the regressor
});

test("heldBackThird: last ceil(n/3) periods held out; passes only on same sign AND holdout CI excluding 0", () => {
  const dates = Array.from({ length: 9 }, (_, i) => `2026-0${i + 1}-01`);
  const strong = heldBackThird(dates.map((d, i) => ({ date: d, ic: 0.2 + 0.01 * i })));
  assert.deepEqual(strong.holdout_dates, dates.slice(6));
  assert.equal(strong.passes, true);
  const flip = heldBackThird(dates.map((d, i) => ({ date: d, ic: i < 6 ? 0.2 : -0.2 + 0.01 * i })));
  assert.equal(flip.passes, false, "sign flip fails (i)");
  const noisy = heldBackThird(dates.map((d, i) => ({ date: d, ic: i < 6 ? 0.1 : [0.3, -0.2, 0.2][i - 6] })));
  assert.equal(noisy.passes, false, "same sign but the 3-point holdout CI spans 0 fails (ii)");
});

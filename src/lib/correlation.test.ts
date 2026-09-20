import test from "node:test";
import assert from "node:assert/strict";
import { alignSeries, logReturns, residualizeTwoFactor, pearson } from "./correlation.ts";

test("alignSeries returns the sorted intersection of every map's keys", () => {
  const a = new Map([["2026-01-01", 1], ["2026-01-02", 2], ["2026-01-03", 3]]);
  const b = new Map([["2026-01-02", 9], ["2026-01-03", 9], ["2026-01-04", 9]]);
  assert.deepEqual(alignSeries(a, b), ["2026-01-02", "2026-01-03"]);
});

test("alignSeries with no maps returns an empty list", () => {
  assert.deepEqual(alignSeries(), []);
});

test("logReturns computes log(p1/p0) for each consecutive pair", () => {
  const series = new Map([["h0", 100], ["h1", 110], ["h2", 99]]);
  const keys = ["h0", "h1", "h2"];
  const returns = logReturns(series, keys);
  assert.equal(returns.length, 2);
  assert.ok(Math.abs(returns[0] - Math.log(110 / 100)) < 1e-9);
  assert.ok(Math.abs(returns[1] - Math.log(99 / 110)) < 1e-9);
});

test("logReturns skips a pair touching a missing or non-positive price instead of producing NaN/Infinity", () => {
  const series = new Map([["h0", 100], ["h1", 0], ["h2", 50], ["h3", -5]]);
  const keys = ["h0", "h1", "h2", "h3", "h4"]; // h4 missing entirely
  const returns = logReturns(series, keys);
  assert.ok(returns.every((r) => Number.isFinite(r)));
  assert.equal(returns.length, 0); // every consecutive pair touches a zero/negative/missing price
});

test("residualizeTwoFactor removes an exact two-factor linear relationship, leaving ~0 residuals", () => {
  const f1 = [1, 2, 3, 4, 5];
  const f2 = [5, 3, 6, 2, 4];
  const y = f1.map((v, i) => 2 * v + 3 * f2[i]); // y is exactly 2*f1 + 3*f2, no noise
  const resid = residualizeTwoFactor(y, f1, f2);
  for (const r of resid) assert.ok(Math.abs(r) < 1e-9, `expected ~0, got ${r}`);
});

test("residualizeTwoFactor falls back to single-factor regression when factors are collinear, without throwing", () => {
  const f1 = [1, 2, 3, 4, 5];
  const f2 = [1, 2, 3, 4, 5]; // identical to f1 -> degenerate 2x2 system
  const y = f1.map((v) => v + 10);
  const resid = residualizeTwoFactor(y, f1, f2);
  assert.equal(resid.length, 5);
  assert.ok(resid.every(Number.isFinite));
});

test("pearson returns 1 for a perfectly positively correlated pair", () => {
  assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
});

test("pearson returns -1 for a perfectly negatively correlated pair", () => {
  const r = pearson([1, 2, 3, 4], [8, 6, 4, 2]);
  assert.ok(r !== null && Math.abs(r - -1) < 1e-9);
});

test("pearson returns null (never NaN) when one series has zero variance", () => {
  assert.equal(pearson([1, 2, 3], [5, 5, 5]), null);
});

test("pearson returns null for mismatched-length or empty inputs", () => {
  assert.equal(pearson([1, 2], [1]), null);
  assert.equal(pearson([], []), null);
});

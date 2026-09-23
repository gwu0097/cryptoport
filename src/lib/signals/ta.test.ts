import test from "node:test";
import assert from "node:assert/strict";
import { sma, ema, wilderRsi, wilderAverages, rsiFrom, stdevPop, priorMax, priorMin } from "./ta.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("sma: mean of the n values ending at i, null before", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("ema: seeded with the SMA at n-1, then alpha = 2/(n+1)", () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  close(e[2]!, 2);
  close(e[3]!, 0.5 * 4 + 0.5 * 2);
  close(e[4]!, 0.5 * 5 + 0.5 * 3);
});

test("wilder RSI(2): seeded mean of the first 2 changes, then RMA; Pine's edge cases", () => {
  // changes: +1, -2, +3, -1
  const closes = [10, 11, 9, 12, 11];
  const { up, down } = wilderAverages(closes, 2);
  close(up[2]!, 0.5); // (1 + 0) / 2
  close(down[2]!, 1); // (0 + 2) / 2
  close(up[3]!, (0.5 * 1 + 3) / 2);
  close(down[3]!, (1 * 1 + 0) / 2);
  close(up[4]!, (up[3]! * 1 + 0) / 2);
  close(down[4]!, (down[3]! * 1 + 1) / 2);
  const r = wilderRsi(closes, 2);
  assert.equal(r[1], null);
  close(r[2]!, 100 - 100 / (1 + 0.5 / 1));
  assert.equal(rsiFrom(0, 0), 100, "Pine: down == 0 -> 100, even when up is 0");
  assert.equal(rsiFrom(0, 1), 0);
});

test("stdevPop: population, not sample", () => {
  close(stdevPop([2, 4, 4, 4, 5, 5, 7, 9], 8)[7]!, 2);
});

test("priorMax / priorMin exclude the current bar", () => {
  assert.deepEqual(priorMax([1, 5, 2, 9, 3], 2), [null, null, 5, 5, 9]);
  assert.deepEqual(priorMin([4, 1, 3, 2, 8], 2), [null, null, 1, 1, 2]);
});

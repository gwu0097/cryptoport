import test from "node:test";
import assert from "node:assert/strict";
import { rangeChange, sliceToRange } from "./chart.ts";

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

test("sliceToRange with days: null returns every point unfiltered", () => {
  const points = [{ date: daysAgo(400) }, { date: daysAgo(1) }];
  assert.deepEqual(sliceToRange(points, null), points);
});

test("sliceToRange with an empty series returns it unchanged", () => {
  assert.deepEqual(sliceToRange([], 7), []);
});

test("sliceToRange excludes a point older than the cutoff", () => {
  const points = [{ date: daysAgo(10) }, { date: daysAgo(2) }];
  const result = sliceToRange(points, 7);
  assert.deepEqual(result, [{ date: daysAgo(2) }]);
});

test("sliceToRange includes a point exactly at the cutoff boundary", () => {
  const points = [{ date: daysAgo(7) }];
  assert.deepEqual(sliceToRange(points, 7), points);
});

test("sliceToRange preserves extra fields on each point", () => {
  const points = [{ date: daysAgo(1), total: 42, kind: "real" as const }];
  assert.deepEqual(sliceToRange(points, 7), points);
});

test("rangeChange: within one kind of point it's last − first", () => {
  assert.deepEqual(rangeChange([{ total: 100, kind: "real" }, { total: 150, kind: "real" }]), { usd: 50, pct: 50, chained: false });
  assert.deepEqual(rangeChange([{ total: 100, kind: "estimated" }, { total: 90, kind: "estimated" }]), { usd: -10, pct: -10, chained: false });
  assert.equal(rangeChange([{ total: 0, kind: "real" }, { total: 5, kind: "real" }]), null);
  assert.equal(rangeChange([]), null);
});

test("rangeChange: across the estimate→real switch, the step between them isn't a gain", () => {
  // Estimate flat at 340 (it leaves out uncovered coins), real starts at
  // 390 and ends at 390: no change at all, not +50.
  const flat = rangeChange([
    { total: 340, kind: "estimated" },
    { total: 340, kind: "estimated" },
    { total: 390, kind: "real" },
    { total: 390, kind: "real" },
  ])!;
  assert.equal(flat.chained, true);
  assert.equal(flat.pct, 0);
  assert.equal(flat.usd, 0);
  // Estimate +10%, real +20%: 1.1 × 1.2 − 1 = +32%, applied to today's value.
  const up = rangeChange([
    { total: 100, kind: "estimated" },
    { total: 110, kind: "estimated" },
    { total: 500, kind: "real" },
    { total: 600, kind: "real" },
  ])!;
  assert.ok(Math.abs(up.pct - 32) < 1e-9);
  assert.ok(Math.abs(up.usd - (600 - 600 / 1.32)) < 1e-9);
});

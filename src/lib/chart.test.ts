import test from "node:test";
import assert from "node:assert/strict";
import { sliceToRange } from "./chart.ts";

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

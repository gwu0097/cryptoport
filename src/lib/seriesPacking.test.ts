import test from "node:test";
import assert from "node:assert/strict";
import { hasPoints, packSeries, roundTotal, unpackSeries } from "./seriesPacking.ts";
import type { StitchedPoint } from "./performance.ts";

test("series round-trip through packing, each keeping only its own dates", () => {
  const a: StitchedPoint[] = [
    { date: "2026-09-01", total: 100.004, kind: "estimated" },
    { date: "2026-09-02", total: 101.5, kind: "real" },
  ];
  const b: StitchedPoint[] = [{ date: "2026-09-02", total: 0.123456, kind: "real" }];
  const { dates, packed } = packSeries([a, b, []]);
  assert.deepEqual(dates, ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(unpackSeries(dates, packed[0]), [
    { date: "2026-09-01", total: 100, kind: "estimated" },
    { date: "2026-09-02", total: 101.5, kind: "real" },
  ]);
  assert.deepEqual(unpackSeries(dates, packed[1]), [{ date: "2026-09-02", total: 0.1235, kind: "real" }]);
  assert.deepEqual(unpackSeries(dates, packed[2]), []);
  assert.equal(hasPoints(packed[2]), false);
  assert.equal(hasPoints(packed[1]), true);
});

test("totals: cents, or 4 significant digits under a dollar; zero stays zero", () => {
  assert.equal(roundTotal(618233.6927920432), 618233.69);
  assert.equal(roundTotal(0.0012346), 0.001235);
  assert.equal(roundTotal(0), 0);
  assert.equal(roundTotal(-12.346), -12.35);
});

test("52 wallets × 381 days pack to a fraction of the objects' size", () => {
  const days = Array.from({ length: 381 }, (_, i) => new Date(Date.UTC(2025, 8, 14 + i)).toISOString().slice(0, 10));
  const series = Array.from({ length: 52 }, (_, w) => days.map((date, i): StitchedPoint => ({ date, total: 618233.6927920432 / (w + 1) + i, kind: i > 360 ? "real" : "estimated" })));
  const before = JSON.stringify(series).length;
  const after = JSON.stringify(packSeries(series)).length;
  assert.ok(after < before / 4, `${after} vs ${before}`);
});

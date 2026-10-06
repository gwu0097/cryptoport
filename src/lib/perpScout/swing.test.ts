import test from "node:test";
import assert from "node:assert/strict";
import { swingStats, swingFailures } from "./swing.ts";
import type { Fill } from "./entries.ts";

const H = 3_600_000;
const D = 24 * H;
const fill = (time: number, side: "A" | "B", sz: number, start: number, oid: number, coin = "ETH"): Fill => ({ coin, px: 1, sz, side, time, startPosition: start, oid });

test("orders, active days and hold time over the window", () => {
  const now = 30 * D;
  const fills = [
    fill(1 * D, "B", 1, 0, 1), fill(1 * D + 1000, "B", 1, 1, 1), // one order in two pieces: opens
    fill(2 * D, "A", 2, 2, 2), // closes after 1 day
    fill(10 * D, "A", 3, 0, 3, "BTC"), // opens a short
    fill(10 * D + 6 * H, "B", 3, -3, 4, "BTC"), // closes after 6 h
    fill(20 * D, "B", 1, 0, 5, "SOL"), // still open
  ];
  const s = swingStats(fills, now);
  assert.equal(Math.round(s.windowDays), 29, "fills reach back only to day 1");
  assert.ok(Math.abs(s.ordersPerWeek - (5 / s.windowDays) * 7) < 1e-9, "5 distinct orders");
  assert.ok(Math.abs(s.activeDaysPerWeek - (4 / s.windowDays) * 7) < 1e-9);
  assert.equal(s.closedTrades, 2);
  assert.equal(s.medianHoldHours, 15, "median of 24 h and 6 h");
});

test("a flip closes one position and opens the other", () => {
  const s = swingStats([fill(0, "B", 1, 0, 1), fill(5 * H, "A", 3, 1, 2), fill(9 * H, "B", 2, -2, 3)], 10 * H);
  assert.equal(s.closedTrades, 2);
  assert.equal(s.medianHoldHours, 4.5);
});

test("swingFailures: too slow, too fast, never closes, holds too long", () => {
  const base = { windowDays: 30, ordersPerWeek: 10, activeDaysPerWeek: 3, closedTrades: 5, medianHoldHours: 30 };
  assert.deepEqual(swingFailures(base), []);
  assert.equal(swingFailures({ ...base, ordersPerWeek: 1 }).length, 1);
  assert.match(swingFailures({ ...base, ordersPerWeek: 500 })[0], /too fast/);
  assert.match(swingFailures({ ...base, medianHoldHours: null })[0], /no position/);
  assert.match(swingFailures({ ...base, medianHoldHours: 40 * 24 })[0], /40 days/);
  assert.match(swingFailures({ ...base, medianHoldHours: 0.5 })[0], /30 min/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { parsePortfolio, traderStats, weeklyChanges, maxDrawdown } from "./portfolio.ts";

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;

test("parsePortfolio prefers the perps all-time window", () => {
  const s = parsePortfolio([
    ["allTime", { accountValueHistory: [[1, "5"]], pnlHistory: [[1, "1"]] }],
    ["perpAllTime", { accountValueHistory: [[2, "10"], [1, "9"]], pnlHistory: [[1, "0"], [2, "3"]] }],
  ]);
  assert.deepEqual(s.accountValue, [[1, 9], [2, 10]], "sorted by time");
  assert.deepEqual(s.pnl, [[1, 0], [2, 3]]);
  assert.throws(() => parsePortfolio([["day", {}]]));
  assert.throws(() => parsePortfolio({}));
});

test("drawdown is measured on the PnL curve", () => {
  assert.equal(maxDrawdown([[0, 0], [1, 100], [2, 40], [3, 120], [4, 90]]), 60);
  assert.equal(maxDrawdown([[0, 0], [1, 10]]), 0);
});

test("weekly changes, newest first, step-sampled", () => {
  const now = 3 * WEEK;
  const pnl: [number, number][] = [[0, 0], [WEEK, 10], [2 * WEEK, 5], [3 * WEEK, 25]];
  assert.deepEqual(weeklyChanges(pnl, now), [20, -5, 10]);
});

test("traderStats: a deposit doesn't count as profit or drawdown; best-4 share and yearly return", () => {
  const now = 52 * WEEK;
  // +10 a week, except one +200 week; account value jumps on a deposit.
  const pnl: [number, number][] = [];
  let v = 0;
  for (let k = 0; k <= 52; k++) {
    pnl.push([k * WEEK, v]);
    v += k === 20 ? 200 : 10;
  }
  const accountValue: [number, number][] = [[0, 1000], [10 * WEEK, 1000], [30 * WEEK, 5000], [40 * WEEK, 1000], [50 * WEEK, 1000]];
  const s = traderStats({ pnl, accountValue }, now);
  assert.equal(s.historyWeeks, 52);
  assert.equal(s.totalPnl, 51 * 10 + 200);
  assert.equal(s.typicalEquity, 1000);
  assert.equal(s.maxDrawdownUsd, 0);
  assert.equal(s.winningWeeksShare, 1);
  assert.equal(s.bestFourShare, (200 + 30) / 710);
  assert.ok(Math.abs((s.yearlyReturn ?? 0) - 0.71 / (52 / 52.18)) < 1e-9);
});

test("traderStats: losing curve has no best-4 share", () => {
  const s = traderStats({ pnl: [[0, 0], [WEEK, -5]], accountValue: [] }, WEEK);
  assert.equal(s.bestFourShare, null);
  assert.equal(s.typicalEquity, null);
  assert.equal(s.drawdownShare, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTrading, type StoredTradingRecord } from "./tradingRecord.ts";

const rec = (over: Partial<StoredTradingRecord>): StoredTradingRecord => ({
  realizedUsd: 0,
  unrealizedUsd: 0,
  investedUsd: 0,
  proceedsUsd: 0,
  closedTokens: 0,
  winningTokens: 0,
  losingTokens: 0,
  distribution: [],
  avgHoldSecs: null,
  firstTradeAt: null,
  lastTradeAt: null,
  days: [],
  drawdownUsd: null,
  drawdownPct: null,
  ...over,
});

test("a year that's flat until one hot month: months, windows and how concentrated the profit is", () => {
  const s = summarizeTrading(
    [
      rec({
        realizedUsd: 1000,
        investedUsd: 10_000,
        proceedsUsd: 11_000,
        closedTokens: 20,
        winningTokens: 11,
        days: [
          ["2025-11-10", 100, 5],
          ["2026-03-02", -50, 3],
          ["2026-09-10", 700, 9],
          ["2026-09-19", 250, 4],
        ],
        drawdownUsd: 300,
        drawdownPct: 40,
      }),
    ],
    "2026-09-28",
  )!;
  assert.deepEqual(s.months.map((m) => [m.month, m.realizedUsd]), [["2025-11", 100], ["2026-03", -50], ["2026-09", 950]]);
  assert.equal(s.yearUsd, 1000);
  assert.equal(s.last30Usd, 950);
  assert.equal(s.last90Usd, 950);
  assert.equal(s.profitableMonths, 2);
  assert.equal(s.bestMonthShare, 0.95);
  assert.deepEqual(s.bestDay, { date: "2026-09-10", realizedUsd: 700 });
  assert.equal(s.allTime.roiPct, 10);
  assert.ok(Math.abs(s.allTime.winRatePct! - 55) < 1e-9);
  assert.equal(s.drawdownPct, 40);
});

test("two addresses combine by day; a drawdown can't be combined, so it's unknown", () => {
  const s = summarizeTrading(
    [rec({ days: [["2026-09-01", 100, 1]], closedTokens: 1, winningTokens: 1, drawdownPct: 10 }), rec({ days: [["2026-09-01", -40, 2]], closedTokens: 1, winningTokens: 0, drawdownPct: 20 })],
    "2026-09-28",
  )!;
  assert.deepEqual(s.months, [{ month: "2026-09", realizedUsd: 60, trades: 3 }]);
  assert.equal(s.allTime.winRatePct, 50);
  assert.equal(s.drawdownPct, null);
});

test("a losing year has no 'share of profit'", () => {
  const s = summarizeTrading([rec({ days: [["2026-09-01", -100, 1]] })], "2026-09-28")!;
  assert.equal(s.bestMonthShare, null);
  assert.equal(s.bestDayShare, null);
  assert.equal(summarizeTrading([], "2026-09-28"), null);
});

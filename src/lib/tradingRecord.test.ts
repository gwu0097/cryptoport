import test from "node:test";
import assert from "node:assert/strict";
import { coinsByMonth, mergeCoins, summarizeTrading, type StoredTradingRecord } from "./tradingRecord.ts";

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

test("coins merge by mint (a coin traded again moves to its new month, counted once) and group by month", () => {
  const now = Date.parse("2026-09-28T00:00:00Z");
  const first = mergeCoins(undefined, [
    { mint: "DUKE", symbol: "DUKE", realizedUsd: -262.69, roiPct: -62.66, lastSellMs: Date.parse("2026-09-28T18:09:35Z"), lastTradeMs: Date.parse("2026-09-28T18:09:35Z") },
    { mint: "OLD", symbol: "OLD", realizedUsd: 50, roiPct: 10, lastSellMs: Date.parse("2025-06-01T00:00:00Z"), lastTradeMs: Date.parse("2025-06-01T00:00:00Z") },
    { mint: "HELD", symbol: "HELD", realizedUsd: 0, roiPct: null, lastSellMs: null, lastTradeMs: Date.parse("2026-09-20T00:00:00Z") },
    { mint: "WIN", symbol: "WIN", realizedUsd: 1200, roiPct: 400, lastSellMs: Date.parse("2026-08-10T00:00:00Z"), lastTradeMs: Date.parse("2026-08-10T00:00:00Z") },
  ], now);
  assert.equal(first.cursor, Date.parse("2026-09-28T18:09:35Z"));
  assert.deepEqual(Object.keys(first.index).sort(), ["DUKE", "WIN"]); // older than a year and unsold are left out
  // WIN is traded again in September: it moves, it isn't counted twice.
  const next = mergeCoins(first, [{ mint: "WIN", symbol: "WIN", realizedUsd: 1500, roiPct: 350, lastSellMs: Date.parse("2026-09-30T00:00:00Z"), lastTradeMs: Date.parse("2026-09-30T00:00:00Z") }], now);
  const months = coinsByMonth([{ ...rec({}), coins: next }]);
  assert.equal(months["2026-08"], undefined);
  assert.equal(months["2026-09"].count, 2);
  assert.equal(months["2026-09"].wins, 1);
  assert.deepEqual(months["2026-09"].top.map((c) => [c.symbol, c.pnlUsd]), [["WIN", 1500]]);
  assert.deepEqual(months["2026-09"].bottom.map((c) => c.symbol), ["DUKE"]);
});

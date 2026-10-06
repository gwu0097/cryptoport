import test from "node:test";
import assert from "node:assert/strict";
import { parseLeaderboard, passesStage1, pickForReview, stage3Failures, traderScore, type LeaderboardRow } from "./screen.ts";
import type { TraderStats } from "./portfolio.ts";

const w = (pnl: number, roi: number, vlm: number) => ({ pnl: String(pnl), roi: String(roi), vlm: String(vlm) });
const raw = (addr: string, av: number, allPnl: number, allRoi: number, monthPnl: number, monthVlm: number) => ({
  ethAddress: addr,
  accountValue: String(av),
  displayName: null,
  windowPerformances: [["day", w(0, 0, 0)], ["week", w(0, 0, 0)], ["month", w(monthPnl, 0.1, monthVlm)], ["allTime", w(allPnl, allRoi, 0)]],
});

test("parseLeaderboard reads windows as numbers and lowercases addresses", () => {
  const rows = parseLeaderboard({ leaderboardRows: [raw("0xABC", 1e6, 5e5, 1.2, 1e4, 2e6), { ethAddress: "0xbad" }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, "0xabc");
  assert.equal(rows[0].allTime.roi, 1.2);
  assert.equal(rows[0].month.vlm, 2e6);
});

test("parseLeaderboard: a changed shape is an error, never an empty leaderboard", () => {
  assert.throws(() => parseLeaderboard({ rows: [] }));
  assert.throws(() => parseLeaderboard({ leaderboardRows: [{ foo: 1 }] }));
  assert.deepEqual(parseLeaderboard({ leaderboardRows: [] }), []);
});

test("stage 1: size, profit, this month, and turnover", () => {
  const [ok, small, losingMonth, mm, lowRoi] = parseLeaderboard({
    leaderboardRows: [
      raw("0x1", 1e6, 5e5, 1, 1, 5e7),
      raw("0x2", 1e4, 5e5, 1, 1, 0),
      raw("0x3", 1e6, 5e5, 1, -1, 0),
      raw("0x4", 1e6, 5e5, 1, 1, 6.1e7),
      raw("0x5", 1e6, 5e5, 0.4, 1, 0),
    ],
  });
  assert.equal(passesStage1(ok), true);
  assert.equal(passesStage1(small), false);
  assert.equal(passesStage1(losingMonth), false);
  assert.equal(passesStage1(mm), false, "61x monthly turnover is a market maker");
  assert.equal(passesStage1(lowRoi), false);
});

test("pickForReview alternates top all-time PnL and top 30-day PnL without repeats", () => {
  const row = (a: string, pnl: number, month: number) => ({ address: a, allTime: { pnl, roi: 1, vlm: 0 }, month: { pnl: month, roi: 0, vlm: 0 } }) as LeaderboardRow;
  const rows = [row("whale", 100, 1), row("big", 90, 0.6), row("hot", 1, 9), row("both", 95, 8)];
  assert.deepEqual(pickForReview(rows, 3).map((r) => r.address), ["whale", "hot", "both"]);
  assert.equal(pickForReview(rows, 10).length, 4);
});

const stats = (o: Partial<TraderStats>): TraderStats => ({
  historyWeeks: 52, totalPnl: 1e6, typicalEquity: 1e6, maxDrawdownUsd: 2e5, drawdownShare: 0.2, winningWeeksShare: 0.6, bestFourShare: 0.5, yearlyReturn: 1, turnover: 40, monthVolume: 5e6, ...o,
});

test("stage 3 names each failure", () => {
  assert.deepEqual(stage3Failures(stats({})), []);
  assert.deepEqual(stage3Failures(stats({ historyWeeks: 10 })), ["short"]);
  assert.deepEqual(stage3Failures(stats({ bestFourShare: 0.9 })), ["luck"]);
  assert.deepEqual(stage3Failures(stats({ bestFourShare: null })), ["unprofitable"]);
  assert.deepEqual(stage3Failures(stats({ drawdownShare: 1.5 })), ["drawdown"]);
  assert.deepEqual(stage3Failures(stats({ typicalEquity: 2e4 })), ["small"]);
});

test("stage 3 rejects what isn't directional perp trading (the first live scan's accounts)", () => {
  // 29 months, every week a win, no drawdown, little perp volume: a farm, vault or rewards.
  const farm = stats({ historyWeeks: 126, winningWeeksShare: 1, drawdownShare: 0, maxDrawdownUsd: 0, turnover: 0.5, monthVolume: 0 });
  assert.deepEqual(stage3Failures(farm).sort(), ["inactive", "notPerps", "smooth"]);
  assert.deepEqual(stage3Failures(stats({ winningWeeksShare: 0.95 })), ["smooth"]);
});

test("score is yearly return over drawdown, floored at 10%", () => {
  assert.equal(traderScore(stats({ yearlyReturn: 1, drawdownShare: 0.5 })), 2);
  assert.equal(traderScore(stats({ yearlyReturn: 1, drawdownShare: 0.01 })), 10);
  assert.equal(traderScore(stats({ yearlyReturn: null })), null);
});

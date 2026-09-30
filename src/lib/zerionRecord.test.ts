import test from "node:test";
import assert from "node:assert/strict";
import { zerionRecord, zerionWindows } from "./zerionRecord.ts";
import { summarizeTrading } from "./tradingRecord.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const pnl = (realizedUsd: number, investedUsd = 1000) => ({ realizedUsd, unrealizedUsd: 0, investedUsd, relativeTotalPct: null });

test("a first load asks all-time, 30/90 days and 12 months; a later one only this month and the windows", () => {
  const first = zerionWindows(null, NOW);
  assert.equal(first.length, 15);
  assert.deepEqual(first.filter((w) => w.kind === "month").map((w) => (w as { month: string }).month).slice(0, 3), ["2026-09", "2026-08", "2026-07"]);
  const stored = zerionRecord(null, first.map((window) => ({ window, pnl: pnl(window.kind === "month" && window.month === "2026-09" ? 162_000 : 0, window.kind === "month" && window.month === "2026-09" ? 1_400_000 : 0) })), NOW);
  // Same month: only September (still running) again.
  assert.deepEqual(zerionWindows(stored, NOW + 3_600_000).map((w) => (w.kind === "month" ? w.month : w.kind)), ["all", "d30", "d90", "2026-09"]);
  // Next month: October, and September once more (it was stored mid-month).
  const oct = zerionWindows(stored, NOW + 86_400_000);
  assert.deepEqual(oct.map((w) => (w.kind === "month" ? w.month : w.kind)), ["all", "d30", "d90", "2026-10", "2026-09"]);
  const done = zerionRecord(stored, oct.map((window) => ({ window, pnl: pnl(1) })), NOW + 86_400_000);
  assert.deepEqual(zerionWindows(done, NOW + 2 * 86_400_000).map((w) => (w.kind === "month" ? w.month : w.kind)), ["all", "d30", "d90", "2026-10"]);
});

test("the record shows months with activity, the windows, and never a 0 for a window Zerion couldn't answer", () => {
  const windows = zerionWindows(null, NOW);
  const answers = windows.map((window) => ({
    window,
    pnl:
      window.kind === "d90" ? null
      : window.kind === "month" ? (window.month === "2026-09" ? pnl(162_483, 1_414_327) : window.month === "2026-08" ? pnl(-2_009, 192_100) : pnl(0, 0))
      : pnl(160_474, 1_606_427),
  }));
  const record = zerionRecord(null, answers, NOW)!;
  const s = summarizeTrading([record], "2026-09-30")!;
  assert.deepEqual(s.months.map((m) => [m.month, Math.round(m.realizedUsd)]), [["2026-08", -2009], ["2026-09", 162483]]);
  assert.equal(s.last90Usd, null);
  assert.equal(Math.round(s.last30Usd!), 160474);
  assert.equal(s.allTime.winRatePct, null);
  assert.equal(record.firstTradeAt, "2026-08-01T00:00:00.000Z");
});

test("no all-time answer, no record", () => {
  assert.equal(zerionRecord(null, [{ window: { kind: "all" }, pnl: null }], NOW), null);
});

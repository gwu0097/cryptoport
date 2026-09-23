import test from "node:test";
import assert from "node:assert/strict";
import { formatTimeInZone, formatAxisInZone, formatSpan, signalRecency } from "./time.ts";

const LA = "America/Los_Angeles";

test("formatTimeInZone shows the zone's DST-correct abbreviation", () => {
  // 2026-09-22 00:00 UTC = Sep 21, 5:00 PM PDT (DST in effect)
  assert.equal(formatTimeInZone(Date.UTC(2026, 8, 22, 0, 0) / 1000, LA), "Sep 21, 5:00 PM PDT");
  assert.equal(formatTimeInZone(Date.UTC(2026, 8, 22, 0, 0) / 1000, "Asia/Tokyo"), "Sep 22, 9:00 AM GMT+9");
  // 2026-01-15 12:00 UTC = Jan 15, 4:00 AM PST (standard time)
  assert.equal(formatTimeInZone(Date.UTC(2026, 0, 15, 12, 0) / 1000, LA), "Jan 15, 4:00 AM PST");
});

test("formatAxisInZone: the date at local midnight, else the time", () => {
  assert.equal(formatAxisInZone(Date.UTC(2026, 8, 22, 7, 0) / 1000, LA), "Sep 22"); // 00:00 PDT
  assert.equal(formatAxisInZone(Date.UTC(2026, 8, 22, 12, 0) / 1000, LA), "5:00 AM");
  assert.equal(formatAxisInZone(Date.UTC(2026, 8, 22, 0, 0) / 1000, "UTC"), "Sep 22");
});

test("formatSpan uses the two coarsest units", () => {
  assert.equal(formatSpan(45 * 60), "45m");
  assert.equal(formatSpan(3 * 3600 + 5 * 60), "3h 5m");
  assert.equal(formatSpan(2 * 86_400 + 4 * 3600 + 59), "2d 4h");
  assert.equal(formatSpan(2 * 3600), "2h");
  assert.equal(formatSpan(-10), "0m");
});

test("signalRecency is measured in the chart's own bars", () => {
  const now = 1_000_000;
  assert.equal(signalRecency(now - 30 * 60, now, 3600), "within_bar"); // 30m on 1H
  assert.equal(signalRecency(now - 2 * 3600, now, 3600), "within_block"); // 2h on 1H
  assert.equal(signalRecency(now - 2 * 3600, now, 4 * 3600), "within_bar"); // 2h on 4H
  assert.equal(signalRecency(now - 20 * 3600, now, 3600), "within_day");
  assert.equal(signalRecency(now - 30 * 3600, now, 4 * 3600), "older");
});

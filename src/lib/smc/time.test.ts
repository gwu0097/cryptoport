import test from "node:test";
import assert from "node:assert/strict";
import { formatTimeInZone, formatTickInZone, TICK, formatSpan, signalRecency, barsAgo } from "./time.ts";

const LA = "America/Los_Angeles";

const NOW_2026 = Date.UTC(2026, 8, 23, 12, 0) / 1000;

test("formatTimeInZone shows the zone's DST-correct abbreviation", () => {
  // 2026-09-22 00:00 UTC = Sep 21, 5:00 PM PDT (DST in effect)
  assert.equal(formatTimeInZone(Date.UTC(2026, 8, 22, 0, 0) / 1000, LA, NOW_2026), "Sep 21, 5:00 PM PDT");
  assert.equal(formatTimeInZone(Date.UTC(2026, 8, 22, 0, 0) / 1000, "Asia/Tokyo", NOW_2026), "Sep 22, 9:00 AM GMT+9");
  // 2026-01-15 12:00 UTC = Jan 15, 4:00 AM PST (standard time)
  assert.equal(formatTimeInZone(Date.UTC(2026, 0, 15, 12, 0) / 1000, LA, NOW_2026), "Jan 15, 4:00 AM PST");
});

test("formatTimeInZone shows the year whenever it isn't the current year (in that zone)", () => {
  // The kPEPE case: a 2025 signal must never read as "Aug 9" in 2026.
  assert.equal(formatTimeInZone(Date.UTC(2025, 7, 9, 0, 0) / 1000, "UTC", NOW_2026), "Aug 9, 2025, 12:00 AM UTC");
  // Year boundary judged in the display zone: 2026-01-01 03:00 UTC is still Dec 31, 2025 in LA.
  assert.equal(formatTimeInZone(Date.UTC(2026, 0, 1, 3, 0) / 1000, LA, NOW_2026), "Dec 31, 2025, 7:00 PM PST");
  assert.equal(formatTimeInZone(Date.UTC(2026, 0, 1, 3, 0) / 1000, "UTC", NOW_2026), "Jan 1, 3:00 AM UTC");
});

test("axis ticks: dates on 1D/4H, times on 1H — never every gridline reading 5:00 PM", () => {
  const utcMidnight = Date.UTC(2026, 8, 22, 0, 0) / 1000; // = Sep 21, 5 PM PDT — where the library puts day ticks
  assert.equal(formatTickInZone(utcMidnight, LA, TICK.DayOfMonth, "1D"), "Sep 21");
  assert.equal(formatTickInZone(utcMidnight, LA, TICK.DayOfMonth, "4H"), "Sep 21");
  assert.equal(formatTickInZone(utcMidnight, LA, TICK.DayOfMonth, "1H"), "Sep 21, 5 PM");
  const eightUtc = Date.UTC(2026, 8, 22, 8, 0) / 1000; // 1 AM PDT
  assert.equal(formatTickInZone(eightUtc, LA, TICK.Time, "1H"), "1:00 AM");
  assert.equal(formatTickInZone(eightUtc, LA, TICK.Time, "4H"), "Sep 22, 1 AM");
  assert.equal(formatTickInZone(utcMidnight, "UTC", TICK.DayOfMonth, "1D"), "Sep 22");
  assert.equal(formatTickInZone(Date.UTC(2026, 0, 1) / 1000, "UTC", TICK.Year, "1D"), "Jan 1, 2026");
  assert.equal(formatTickInZone(Date.UTC(2026, 8, 1) / 1000, "UTC", TICK.Month, "1D"), "Sep 1");
  // A month tick at Sep 1 00:00 UTC is Aug 31 locally — never a bare "Sep" (wrong month) or "Aug 26" (reads as a date).
  assert.equal(formatTickInZone(Date.UTC(2026, 8, 1) / 1000, LA, TICK.Month, "4H"), "Aug 31");
  assert.equal(formatTickInZone(Date.UTC(2026, 0, 1) / 1000, LA, TICK.Year, "1D"), "Dec 31, 2025");
  // consecutive daily ticks now differ
  const labels = [0, 1, 2].map((k) => formatTickInZone(utcMidnight + k * 86_400, LA, TICK.DayOfMonth, "1D"));
  assert.equal(new Set(labels).size, 3);
});

test("formatSpan uses the two coarsest units", () => {
  assert.equal(formatSpan(45 * 60), "45m");
  assert.equal(formatSpan(3 * 3600 + 5 * 60), "3h 5m");
  assert.equal(formatSpan(2 * 86_400 + 4 * 3600 + 59), "2d 4h");
  assert.equal(formatSpan(2 * 3600), "2h");
  assert.equal(formatSpan(-10), "0m");
  assert.equal(formatSpan(410 * 86_400 + 5 * 3600), "1y 45d");
  assert.equal(formatSpan(365 * 86_400), "1y");
});

test("signalRecency is measured in the chart's own bars", () => {
  const now = 1_000_000;
  assert.equal(signalRecency(now - 30 * 60, now, 3600), "within_bar"); // 30m on 1H
  assert.equal(signalRecency(now - 2 * 3600, now, 3600), "within_block"); // 2h on 1H
  assert.equal(signalRecency(now - 2 * 3600, now, 4 * 3600), "within_bar"); // 2h on 4H
  assert.equal(signalRecency(now - 20 * 3600, now, 3600), "within_day");
  assert.equal(signalRecency(now - 30 * 3600, now, 4 * 3600), "older");
});

test("a last signal 30+ bars old is stale, measured in the chart's own bars", () => {
  const now = 100_000_000;
  assert.equal(signalRecency(now - 29 * 3600, now, 3600), "older");
  assert.equal(signalRecency(now - 30 * 3600, now, 3600), "stale"); // 30 bars on 1H
  assert.equal(signalRecency(now - 29 * 86_400, now, 86_400), "older");
  assert.equal(signalRecency(now - 410 * 86_400, now, 86_400), "stale"); // the kPEPE case on 1D
  assert.equal(barsAgo(now - 410 * 86_400, now, 86_400), 410);
});

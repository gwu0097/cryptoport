import test from "node:test";
import assert from "node:assert/strict";
import { isValidTimeZone, resolveTimeZone, listTimeZones, timeZoneLabel, tradingViewTimeZone } from "./timezone.ts";

test("isValidTimeZone accepts IANA zones and rejects junk", () => {
  assert.equal(isValidTimeZone("America/Los_Angeles"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
});

test("resolveTimeZone: saved > browser-detected > UTC, skipping invalid values", () => {
  assert.deepEqual(resolveTimeZone("Asia/Tokyo", "America/Los_Angeles"), { tz: "Asia/Tokyo", source: "saved" });
  assert.deepEqual(resolveTimeZone(null, "America/Los_Angeles"), { tz: "America/Los_Angeles", source: "detected" });
  assert.deepEqual(resolveTimeZone("not/a zone", "bad"), { tz: "UTC", source: "fallback" });
});

test("listTimeZones includes the common zones", () => {
  const zones = listTimeZones();
  for (const z of ["America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Tokyo"]) assert.ok(zones.includes(z), z);
});

test("timeZoneLabel shows the current abbreviation and offset", () => {
  assert.equal(timeZoneLabel("America/Los_Angeles", new Date(Date.UTC(2026, 8, 22))), "America/Los_Angeles (PDT, UTC-7)");
  assert.equal(timeZoneLabel("America/Los_Angeles", new Date(Date.UTC(2026, 0, 15))), "America/Los_Angeles (PST, UTC-8)");
});

test("tradingViewTimeZone passes supported zones through and falls back to UTC otherwise", () => {
  assert.equal(tradingViewTimeZone("America/Los_Angeles"), "America/Los_Angeles");
  assert.equal(tradingViewTimeZone("UTC"), "Etc/UTC");
  assert.equal(tradingViewTimeZone("America/Boise"), "Etc/UTC");
});

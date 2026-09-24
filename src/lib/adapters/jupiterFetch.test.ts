import test from "node:test";
import assert from "node:assert/strict";
import { reserveSlot, waitAfter429Ms } from "./jupiterFetch.ts";

test("requests are spaced one pace apart, never scheduled in the past", () => {
  assert.deepEqual(reserveSlot(1000, 0, 1100), { startAt: 1000, next: 2100 });
  assert.deepEqual(reserveSlot(1500, 2100, 1100), { startAt: 2100, next: 3200 });
});

test("a 429 waits for the window reset, bounded", () => {
  assert.equal(waitAfter429Ms("1790293319", 1790293314_000), 5_250);
  assert.equal(waitAfter429Ms(null, 0), 5_000);
  assert.equal(waitAfter429Ms("1", 5_000_000), 1_000, "a reset in the past still waits a second");
  assert.equal(waitAfter429Ms("9999999999", 0), 30_000);
});

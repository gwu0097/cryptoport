import test from "node:test";
import assert from "node:assert/strict";
import { isOpen, newBreaker, OPEN_MS, recordFailure, recordSuccess } from "./dbBreaker.ts";

test("three failures within a minute skip the database for a minute, then it's tried again", () => {
  const b = newBreaker();
  recordFailure(b, 0);
  recordFailure(b, 10_000);
  assert.equal(isOpen(b, 10_000), false);
  recordFailure(b, 20_000);
  assert.equal(isOpen(b, 20_001), true);
  assert.equal(isOpen(b, 20_000 + OPEN_MS), false);
});

test("failures spread out, or broken by a success, don't open it", () => {
  const b = newBreaker();
  recordFailure(b, 0);
  recordFailure(b, 50_000);
  recordFailure(b, 120_000); // the first is over a minute old
  assert.equal(isOpen(b, 120_000), false);
  recordFailure(b, 121_000);
  recordSuccess(b);
  recordFailure(b, 122_000);
  assert.equal(isOpen(b, 122_000), false);
});

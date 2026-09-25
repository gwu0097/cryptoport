import test from "node:test";
import assert from "node:assert/strict";
import { windowDelay } from "./rateWindow.ts";

test("under the budget: go now; expired entries are dropped", () => {
  const recent = [0, 10, 20];
  assert.equal(windowDelay(recent, 100, 3, 60), 0, "all three are older than the 60ms window");
  assert.deepEqual(recent, []);
});

test("at the budget: wait until the oldest counted request leaves the window", () => {
  const recent = [100, 110, 120];
  assert.equal(windowDelay(recent, 130, 3, 60), 30);
  assert.equal(windowDelay([100, 110, 120], 130, 4, 60), 0);
});

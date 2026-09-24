import test from "node:test";
import assert from "node:assert/strict";
import { requestWeight, WeightBudget } from "./hlWeight.ts";

test("requestWeight follows Hyperliquid's /info rules", () => {
  assert.equal(requestWeight("allMids"), 2);
  assert.equal(requestWeight("meta"), 20);
  assert.equal(requestWeight("candleSnapshot", 600), 30); // the user's own example
  assert.equal(requestWeight("candleSnapshot", 601), 31);
  assert.equal(requestWeight("candleSnapshot", 3), 21);
  assert.equal(requestWeight("candleSnapshot", 0), 20);
});

test("the budget is a sliding one-minute window", () => {
  const b = new WeightBudget(900, 60_000);
  b.record(500, 0);
  b.record(300, 30_000);
  assert.equal(b.spent(30_000), 800);
  assert.equal(b.canSpend(100, 30_000), true);
  assert.equal(b.canSpend(101, 30_000), false);
  // the first spend ages out at t = 60s
  assert.equal(b.spent(60_001), 300);
  assert.equal(b.canSpend(600, 60_001), true);
  assert.equal(b.nextFitAt(200, 30_000), 60_000);
});

test("a real 429 blocks everything for the window, whatever this process counted", () => {
  const b = new WeightBudget();
  b.block(10_000);
  assert.equal(b.canSpend(2, 10_000), false);
  assert.equal(b.blockedUntil(10_000), 70_000);
  assert.equal(b.nextFitAt(2, 10_000), 70_000);
  assert.equal(b.canSpend(2, 70_000), true);
});

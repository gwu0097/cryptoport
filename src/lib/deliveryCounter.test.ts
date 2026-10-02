import test from "node:test";
import assert from "node:assert/strict";
import { countDeliveries, type DeliveryCounter } from "./deliveryCounter.ts";

test("an hour's deliveries per address; older ones drop off", () => {
  const c: DeliveryCounter = new Map();
  assert.equal(countDeliveries(c, "A", 0, 3), 3);
  assert.equal(countDeliveries(c, "B", 1_000), 1);
  assert.equal(countDeliveries(c, "A", 30 * 60_000), 4);
  assert.equal(countDeliveries(c, "A", 61 * 60_000), 2); // the first three are over an hour old
});

test("a minute's window for the fast stops", () => {
  const c: DeliveryCounter = new Map();
  countDeliveries(c, "A", 0, 50, 60_000);
  assert.equal(countDeliveries(c, "A", 30_000, 20, 60_000), 70);
  assert.equal(countDeliveries(c, "A", 61_000, 1, 60_000), 21);
});

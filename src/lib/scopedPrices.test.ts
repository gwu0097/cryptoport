import test from "node:test";
import assert from "node:assert/strict";
import { GuardedMap, guardRecord } from "./scopedPrices.ts";

test("a record reports a lookup of a coin outside it, and still answers undefined", () => {
  const misses: string[] = [];
  const prices = guardRecord<Record<string, number | null>>({ bitcoin: 60000, dead: null }, (k) => misses.push(k), (k) => k.startsWith("hlperp:"));
  assert.equal(prices.bitcoin, 60000);
  assert.equal(prices.dead, null); // covered, just unpriced: not a miss
  assert.equal(prices["jup:abc"], undefined);
  assert.equal(prices["hlperp:BTC"], undefined); // exempt (a mark until Refresh prices stores one)
  assert.deepEqual(misses, ["jup:abc"]);
});

test("awaiting or serializing a guarded record isn't a miss", async () => {
  const misses: string[] = [];
  const prices = guardRecord<Record<string, number>>({ bitcoin: 1 }, (k) => misses.push(k));
  assert.equal(await Promise.resolve(prices), prices);
  JSON.stringify(prices);
  assert.deepEqual(misses, []);
});

test("a map reports get() of a key it doesn't hold", () => {
  const misses: string[] = [];
  const stats = new GuardedMap<number>((k) => misses.push(k));
  stats.set("bitcoin", 1);
  assert.equal(stats.get("bitcoin"), 1);
  assert.equal(stats.get("eth"), undefined);
  assert.equal(stats.has("eth"), false); // has() is a question, not a lookup
  assert.deepEqual(misses, ["eth"]);
});

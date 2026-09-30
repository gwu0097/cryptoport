import test from "node:test";
import assert from "node:assert/strict";
import { openingLegs } from "./entryLiquidity.ts";
import type { ActivityLeg } from "./watchActivity.ts";

let n = 0;
const buy = (usd: number, over: Partial<ActivityLeg> = {}): ActivityLeg => ({
  txId: `t${++n}`, assetKey: "jup:gem", sourceChain: "solana", priceKey: "jup:gem", ticker: "GEM", contract: "Gem111",
  qtyDelta: usd / 0.01, kind: "swap", counterparty: null, priceUsd: 0.01, at: `2026-09-30T10:${String(n).padStart(2, "0")}:00Z`, checkedAt: "x", ...over,
});

test("the delivery whose buys reach $100 opens the position: its first buy carries the figure", () => {
  const first = buy(60);
  assert.deepEqual(openingLegs([], [first], {}), []); // $60: not open yet
  const second = buy(50);
  assert.deepEqual(openingLegs([first], [second], {}).map((l) => l.txId), [second.txId]);
});

test("asked once: never again for the same coin, never for one held at the read", () => {
  const opened = { ...buy(150), entryLiqUsd: 7200 };
  assert.deepEqual(openingLegs([opened], [buy(500)], {}), []);
  assert.deepEqual(openingLegs([], [buy(500)], { "jup:gem": { qty: 10_000, kept: false } }), []); // $100 held
  assert.equal(openingLegs([], [buy(500)], { "jup:gem": { qty: 5, kept: false } }).length, 1); // 5¢ of dust isn't a position
});

test("sells, unsized buys and native coins don't open anything", () => {
  assert.deepEqual(openingLegs([], [buy(500, { qtyDelta: -50_000 })], {}), []);
  assert.deepEqual(openingLegs([], [buy(500, { priceUsd: null })], {}), []);
  assert.deepEqual(openingLegs([], [buy(500, { contract: null })], {}), []);
});

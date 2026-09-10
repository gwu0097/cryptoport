import test from "node:test";
import assert from "node:assert/strict";
import { extractSpotAmount } from "./coinbase.ts";

test("extractSpotAmount reads data.amount from a well-formed response", () => {
  const json = { data: { base: "BTC", currency: "USD", amount: "60000.12" } };
  assert.equal(extractSpotAmount("BTC", json), "60000.12");
});

test("extractSpotAmount rejects a missing data object", () => {
  assert.throws(() => extractSpotAmount("BTC", {}), /no usable "data.amount"/);
});

test("extractSpotAmount rejects a missing amount field", () => {
  assert.throws(() => extractSpotAmount("BTC", { data: {} }), /no usable "data.amount"/);
});

test("extractSpotAmount rejects a non-string amount", () => {
  assert.throws(() => extractSpotAmount("BTC", { data: { amount: 60000 } }));
});

test("extractSpotAmount rejects null/undefined bodies", () => {
  assert.throws(() => extractSpotAmount("BTC", null));
  assert.throws(() => extractSpotAmount("BTC", undefined));
});

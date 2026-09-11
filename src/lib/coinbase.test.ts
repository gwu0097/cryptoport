import test from "node:test";
import assert from "node:assert/strict";
import { extractSpotAmount, isDelistedProduct, extractPriceChange24h } from "./coinbase.ts";

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

test("isDelistedProduct is true for a delisted status", () => {
  assert.equal(isDelistedProduct({ status: "delisted", trading_disabled: true }), true);
});

test("isDelistedProduct is true for trading_disabled alone, regardless of status text", () => {
  // Verified against the live Coinbase Exchange API for JUP-USD — this is
  // the actual root cause of a real bug (JUP priced at $0.0003 instead of
  // ~$0.25): status/trading_disabled confirm delisting, but the separate
  // v2 spot-price endpoint keeps serving a frozen pre-delisting number.
  assert.equal(isDelistedProduct({ status: "unknown", trading_disabled: true }), true);
});

test("isDelistedProduct is false for an online, tradable product", () => {
  assert.equal(isDelistedProduct({ status: "online", trading_disabled: false }), false);
});

test("isDelistedProduct is false for a missing/malformed body (not evidence of delisting)", () => {
  assert.equal(isDelistedProduct({}), false);
  assert.equal(isDelistedProduct(null), false);
  assert.equal(isDelistedProduct(undefined), false);
});

test("extractPriceChange24h computes percent change from open to last", () => {
  // Round numbers so the expected value is exact, not a floating-point
  // approximation to eyeball — real responses (e.g. Coinbase Exchange's
  // /products/BTC-USD/stats: {"open":"77218.91","last":"78990.99",...})
  // aren't round, but the formula is the same either way.
  assert.equal(extractPriceChange24h({ open: "100", last: "105" }), 5);
  assert.equal(extractPriceChange24h({ open: "100", last: "95" }), -5);
});

test("extractPriceChange24h returns null for a missing or zero open (division by zero)", () => {
  assert.equal(extractPriceChange24h({ last: "105" }), null);
  assert.equal(extractPriceChange24h({ open: "0", last: "105" }), null);
});

test("extractPriceChange24h returns null for a missing/malformed body", () => {
  assert.equal(extractPriceChange24h({}), null);
  assert.equal(extractPriceChange24h(null), null);
  assert.equal(extractPriceChange24h({ open: "not-a-number", last: "105" }), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMapping } from "./exchangeMappings.ts";

const sources = new Map([
  ["coinbase|MORPHO", "coinbase-registry"],
  ["kraken|MORPHO", "coinbase-catalog"],
  ["hyperliquid|USDE", "manual"],
]);

test("canonical stablecoins and cash", () => {
  assert.equal(classifyMapping({ venue: "kraken", ticker: "usdc", price_key: "usd-coin" }, sources), "canonical");
  assert.equal(classifyMapping({ venue: "coinbase", ticker: "USD", price_key: "fiat:USD" }, sources), "canonical");
});

test("native coins", () => {
  assert.equal(classifyMapping({ venue: "gemini", ticker: "ETH", price_key: "ethereum" }, sources), "native");
  assert.equal(classifyMapping({ venue: "hyperliquid", ticker: "HYPE", price_key: "hyperliquid" }, sources), "native");
});

test("a key with no mapping row is not passed off as native", () => {
  assert.equal(classifyMapping({ venue: "coinbase", ticker: "RPL", price_key: "rocket-pool" }, sources), "override");
});

test("the venue's own list vs. a copy needing review", () => {
  assert.equal(classifyMapping({ venue: "coinbase", ticker: "MORPHO", price_key: "morpho" }, sources), "venue-list");
  assert.equal(classifyMapping({ venue: "kraken", ticker: "MORPHO", price_key: "morpho" }, sources), "copied");
  assert.equal(classifyMapping({ venue: "hyperliquid", ticker: "USDE", price_key: "ethena-usde" }, sources), "venue-list");
});

test("venue-priced and unpriced", () => {
  assert.equal(classifyMapping({ venue: "coinbase", ticker: "XYZ", price_key: "coinbase:XYZ" }, sources), "venue-price");
  assert.equal(classifyMapping({ venue: "hyperliquid", ticker: "PURR", price_key: "hl:PURR" }, sources), "venue-price");
  assert.equal(classifyMapping({ venue: "mexc", ticker: "ABC", price_key: null }, sources), "unpriced");
});

import test from "node:test";
import assert from "node:assert/strict";
import { planPriceWrites, sourceOf } from "./assetPriceWrites.ts";

const NOW = "2026-09-25T18:00:00.000Z";

test("a returned price replaces the stored one and clears missing state", () => {
  const [w] = planPriceWrites(["morpho"], new Map([["morpho", { usd: 2.75, change_24h: -5.6, source: "coingecko" }]]), new Map(), new Map(), NOW);
  assert.deepEqual(w, { price_key: "morpho", usd: 2.75, change_24h: -5.6, source: "coingecko", updated_at: NOW, last_attempt_at: NOW, missing_since: null, last_error: null });
});

test("a key the source didn't return never gets a price field (the stored price stays)", () => {
  const [w] = planPriceWrites(["matic-network"], new Map(), new Map(), new Map(), NOW);
  assert.equal("usd" in w, false);
  assert.deepEqual(w, { price_key: "matic-network", last_attempt_at: NOW, missing_since: NOW, last_error: "not returned by its source" });
});

test("missing_since keeps the first time it went missing; an error message is recorded", () => {
  const [w] = planPriceWrites(["x"], new Map(), new Map([["x", "HTTP 429"]]), new Map([["x", "2026-09-24T00:00:00Z"]]), NOW);
  assert.deepEqual(w, { price_key: "x", last_attempt_at: NOW, missing_since: "2026-09-24T00:00:00Z", last_error: "HTTP 429" });
});

test("a zero or non-finite price counts as not returned; keys are deduped", () => {
  const writes = planPriceWrites(["a", "a", "b"], new Map([["a", { usd: 0, source: "x" }], ["b", { usd: NaN, source: "x" }]]), new Map(), new Map(), NOW);
  assert.equal(writes.length, 2);
  assert.ok(writes.every((w) => !("usd" in w)));
});

test("one source per key, by namespace", () => {
  assert.equal(sourceOf("usd-coin"), "coingecko");
  assert.equal(sourceOf("jup:J1toso1"), "jupiter");
  assert.equal(sourceOf("hlperp:LIT"), "hyperliquid"); // a perp's mark price, not a CoinGecko id
  assert.equal(sourceOf("lighterperp:BTC"), "lighter");
  assert.equal(sourceOf("asterperp:BTCUSDT"), "aster");
  assert.equal(sourceOf("hl:PURR"), "hyperliquid");
  assert.equal(sourceOf("coinbase:LRDS"), "coinbase");
});

test("fiat keys have their own source", () => {
  assert.equal(sourceOf("fiat:USD"), "fiat");
});

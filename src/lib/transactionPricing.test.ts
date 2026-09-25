import test from "node:test";
import assert from "node:assert/strict";
import { holdingKeyIndex, transactionPriceKey } from "./transactionPricing.ts";

const holdings = holdingKeyIndex([
  { wallet_id: "w1", chain: "solana", ticker: "JUP", price_key: "jupiter-exchange-solana" },
  { wallet_id: "w1", chain: "solana", ticker: "DOG", price_key: "jup:mintA" },
  { wallet_id: "w1", chain: "solana", ticker: "dog", price_key: "jup:mintB" },
  { wallet_id: "w2", chain: "solana", ticker: "JUP", price_key: null },
]);

test("a chain's own coin by its native symbol", () => {
  assert.equal(transactionPriceKey({ wallet_id: "w9", chain: "bitcoin", ticker: "BTC" }, holdings), "bitcoin");
  assert.equal(transactionPriceKey({ wallet_id: "w9", chain: "solana", ticker: "SOL" }, holdings), "solana");
});

test("a token: the coin the same wallet holds under that ticker, only if exactly one", () => {
  assert.equal(transactionPriceKey({ wallet_id: "w1", chain: "solana", ticker: "jup" }, holdings), "jupiter-exchange-solana");
  assert.equal(transactionPriceKey({ wallet_id: "w1", chain: "solana", ticker: "DOG" }, holdings), null); // two coins: never guessed
  assert.equal(transactionPriceKey({ wallet_id: "w2", chain: "solana", ticker: "JUP" }, holdings), null); // another wallet's holding doesn't count
  assert.equal(transactionPriceKey({ wallet_id: "w1", chain: "solana", ticker: null }, holdings), null);
});

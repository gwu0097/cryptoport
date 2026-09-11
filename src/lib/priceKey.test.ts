import test from "node:test";
import assert from "node:assert/strict";
import { resolveCoingeckoKey } from "./priceKey.ts";

test("resolveCoingeckoKey returns null for a manual_usd holding", () => {
  assert.equal(
    resolveCoingeckoKey({ ticker: "MY-NOTE", source: "manual_usd", contract: null, chain: null }),
    null,
  );
});

test("resolveCoingeckoKey builds a platform:contract key for an EVM token", () => {
  assert.equal(
    resolveCoingeckoKey({
      ticker: "WETH",
      source: "auto",
      contract: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      chain: "eth",
    }),
    "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  );
});

test("resolveCoingeckoKey builds a platform:contract key for a Solana SPL token", () => {
  assert.equal(
    resolveCoingeckoKey({
      ticker: "JUP",
      source: "auto",
      contract: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
      chain: "solana",
    }),
    "solana:jupyiwryjfskupiha7hker8vutaefosybkedznsdvcn",
  );
});

test("resolveCoingeckoKey resolves an EVM chain's native token by symbol match", () => {
  assert.equal(
    resolveCoingeckoKey({ ticker: "ETH", source: "auto", contract: null, chain: "eth" }),
    "ethereum",
  );
});

test("resolveCoingeckoKey resolves a non-EVM native token via NATIVE_COINGECKO_IDS", () => {
  assert.equal(
    resolveCoingeckoKey({ ticker: "BTC", source: "auto", contract: null, chain: "bitcoin" }),
    "bitcoin",
  );
});

test("resolveCoingeckoKey returns null when chain is null (pre-chain-column holding)", () => {
  assert.equal(resolveCoingeckoKey({ ticker: "USDC", source: "auto", contract: null, chain: null }), null);
});

test("resolveCoingeckoKey returns null for a contract on a chain with no known platform id", () => {
  assert.equal(
    resolveCoingeckoKey({
      ticker: "SPAM",
      source: "auto",
      contract: "0xdead",
      chain: "some-unmapped-chain",
    }),
    null,
  );
});

test("resolveCoingeckoKey returns null for an unrecognized ticker on a chain with no native mapping", () => {
  assert.equal(
    resolveCoingeckoKey({ ticker: "RANDOM", source: "auto", contract: null, chain: "eth" }),
    null,
  );
});

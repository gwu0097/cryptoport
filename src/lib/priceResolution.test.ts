import test from "node:test";
import assert from "node:assert/strict";
import { splitByCoingeckoResolvability, tickerNeedsPricing, type HoldingTickerInfo } from "./priceResolution.ts";

function ticker(overrides: Partial<HoldingTickerInfo> & { ticker: string; source: string }): HoldingTickerInfo {
  return { contract: null, chain: null, coingeckoId: null, ...overrides };
}

test("splitByCoingeckoResolvability: manual_usd always goes to residual, registry ignored", () => {
  const registry = new Map([["FOO", "foo-coin"]]);
  const { resolved, residual } = splitByCoingeckoResolvability(
    [ticker({ ticker: "FOO", source: "manual_usd" })],
    registry,
  );
  assert.deepEqual(resolved, []);
  assert.deepEqual(residual.map((t) => t.ticker), ["FOO"]);
});

test("splitByCoingeckoResolvability: a real chain-native match resolves without consulting the registry", () => {
  const { resolved, residual } = splitByCoingeckoResolvability(
    [ticker({ ticker: "ETH", source: "auto", chain: "eth", contract: null })],
    new Map(),
  );
  assert.deepEqual(residual, []);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].ticker, "ETH");
  assert.equal(resolved[0].key, "ethereum");
});

test("splitByCoingeckoResolvability: an unresolvable auto_exchange ticker found in the registry resolves via it", () => {
  const registry = new Map([["UNI", "uniswap"]]);
  const { resolved, residual } = splitByCoingeckoResolvability(
    [ticker({ ticker: "UNI", source: "auto_exchange", chain: "coinbase", contract: null })],
    registry,
  );
  assert.deepEqual(residual, []);
  assert.deepEqual(resolved, [{ ticker: "UNI", key: "uniswap" }]);
});

test("splitByCoingeckoResolvability: an auto_exchange ticker NOT in the registry falls to residual", () => {
  const { resolved, residual } = splitByCoingeckoResolvability(
    [ticker({ ticker: "OBSCURE", source: "auto_exchange", chain: "coinbase", contract: null })],
    new Map([["UNI", "uniswap"]]),
  );
  assert.deepEqual(resolved, []);
  assert.deepEqual(residual.map((t) => t.ticker), ["OBSCURE"]);
});

test("splitByCoingeckoResolvability: the registry never applies to a non-exchange source, even if the ticker matches", () => {
  // A DeFi-position ticker sharing a symbol with something Coinbase lists
  // must not get silently matched — the registry's trust justification
  // (an exchange verified this ticker) only holds for auto_exchange rows.
  const registry = new Map([["UNI", "uniswap"]]);
  const { resolved, residual } = splitByCoingeckoResolvability(
    [ticker({ ticker: "UNI", source: "auto_defi", chain: "arb", contract: null })],
    registry,
  );
  assert.deepEqual(resolved, []);
  assert.deepEqual(residual.map((t) => t.ticker), ["UNI"]);
});

test("tickerNeedsPricing: false when every holding already has usd_override", () => {
  assert.equal(
    tickerNeedsPricing([
      { usd_override: "100" },
      { usd_override: "50" },
    ]),
    false,
  );
});

test("tickerNeedsPricing: true when at least one holding lacks usd_override", () => {
  assert.equal(
    tickerNeedsPricing([
      { usd_override: "100" },
      { usd_override: null },
    ]),
    true,
  );
});

test("tickerNeedsPricing: true for an empty-usd_override single holding", () => {
  assert.equal(tickerNeedsPricing([{ usd_override: null }]), true);
});

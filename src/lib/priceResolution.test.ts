import test from "node:test";
import assert from "node:assert/strict";
import { splitByCoingeckoResolvability, tickerNeedsPricing, type HoldingTickerInfo, tickerInfoFor } from "./priceResolution.ts";

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

test("tickerInfoFor prices a ticker through a row that needs it, not an EVM contract row priced at sync", () => {
  const base = { contract: "0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842", chain: "base", source: "auto", coingecko_id: null, usd_override: 7975 };
  const coinbase = { contract: null, chain: "coinbase", source: "auto_exchange", coingecko_id: null, usd_override: null };
  // MORPHO on Base (usd_override from sync) + on Coinbase (needs the ticker price).
  assert.deepEqual(tickerInfoFor("MORPHO", [base, base, coinbase]), {
    ticker: "MORPHO",
    contract: null,
    chain: "coinbase",
    coingeckoId: null,
    source: "auto_exchange",
  });
  assert.equal(tickerInfoFor("MORPHO", [base]), null, "every row priced at sync: nothing to do");
});

test("tickerInfoFor still prefers a native row over a bridged contract row among rows that need pricing", () => {
  const scrollEth = { contract: "0x5300000000000000000000000000000000000004", chain: "scrl", source: "manual_qty", coingecko_id: null, usd_override: null };
  const btcNative = { contract: null, chain: "bitcoin", source: "auto", coingecko_id: null, usd_override: null };
  const info = tickerInfoFor("BTC", [scrollEth, btcNative]);
  assert.equal(info?.contract, null);
  assert.equal(info?.chain, "bitcoin");
});

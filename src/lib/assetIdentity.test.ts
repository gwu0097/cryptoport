import test from "node:test";
import assert from "node:assert/strict";
import { resolvePriceKey, isPositionValue, contractKey, venueKey, NATIVE_BY_SYMBOL, type KeyInput, type KeyMaps } from "./assetIdentity.ts";

const MORPHO = "0xBAA5CC21fd487B8Fcc2F632f3F4E8D37262a0842";
const maps: KeyMaps = {
  registry: new Map([
    [contractKey("base", MORPHO), "morpho"],
    [contractKey("solana", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"), "jito-staked-sol"],
    [contractKey("scrl", "0x5300000000000000000000000000000000000004"), "scroll-bridged-weth-scroll"],
  ]),
  overrides: new Map([[contractKey("sui", "native"), "sui"]]),
  venues: new Map([
    [venueKey("coinbase", "MORPHO"), "morpho"],
    [venueKey("hyperliquid", "USDC"), "usd-coin"],
    [venueKey("polymarket", "PUSD"), "polymarket-usd"],
  ]),
};
const h = (o: Partial<KeyInput> & { ticker: string }): KeyInput => ({ chain: null, contract: null, source: "auto", ...o });

test("the same coin gets the same key from a contract and from an exchange (MORPHO)", () => {
  assert.equal(resolvePriceKey(h({ ticker: "MORPHO", chain: "base", contract: MORPHO }), maps), "morpho");
  assert.equal(resolvePriceKey(h({ ticker: "MORPHO", chain: "coinbase", source: "auto_exchange" }), maps), "morpho");
});

test("unmapped exchange tickers: Coinbase gets its own namespaced key, others stay unpriced (no ticker guess)", () => {
  assert.equal(resolvePriceKey(h({ ticker: "LRDS", chain: "coinbase", source: "auto_exchange" }), maps), "coinbase:LRDS");
  assert.equal(resolvePriceKey(h({ ticker: "LRDS", chain: "kraken", source: "auto_exchange" }), maps), null);
});

test("natives resolve by chain only when the ticker is that chain's native symbol", () => {
  assert.equal(resolvePriceKey(h({ ticker: "ETH", chain: "base" }), maps), "ethereum");
  assert.equal(resolvePriceKey(h({ ticker: "SOL", chain: "solana-defi", category: "defi" }), maps), "solana", "native stake is SOL");
  assert.equal(resolvePriceKey(h({ ticker: "SUI", chain: "sui" }), maps), "sui", "an override wins");
  assert.equal(resolvePriceKey(h({ ticker: "NOTNATIVE", chain: "base" }), maps), null);
});

test("contracts map through CoinGecko's own contract list; bridged copies keep their own coin", () => {
  assert.equal(resolvePriceKey(h({ ticker: "ETH", chain: "scrl", contract: "0x5300000000000000000000000000000000000004" }), maps), "scroll-bridged-weth-scroll");
  assert.equal(resolvePriceKey(h({ ticker: "JITOSOL", chain: "solana-defi", contract: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", category: "defi" }), maps), "jito-staked-sol");
  assert.equal(resolvePriceKey(h({ ticker: "ORCA", chain: "solana", contract: "SpoofedMint111" }), maps), "jup:SpoofedMint111", "an unlisted mint is priced as itself, never as the real ORCA");
  assert.equal(resolvePriceKey(h({ ticker: "X", chain: "base", contract: "0xdead" }), maps), null);
});

test("Hyperliquid: listed coins by id, spot long tail as hl:, stables by id (no $1 pin)", () => {
  assert.equal(resolvePriceKey(h({ ticker: "HYPE", chain: "hyperliquid", protocol_section: "Deposit" }), maps), "hyperliquid");
  assert.equal(resolvePriceKey(h({ ticker: "PURR", chain: "hyperliquid", protocol_section: "Deposit" }), maps), "hl:PURR");
  assert.equal(resolvePriceKey(h({ ticker: "USDC", chain: "hyperliquid", protocol_section: "Rewards" }), maps), "usd-coin");
});

test("protocol positions have no price key (their stored value stands)", () => {
  for (const x of [
    h({ ticker: "W-PERP", chain: "hyperliquid", protocol_section: "Perpetuals" }),
    h({ ticker: "USDC", chain: "hyperliquid", protocol_section: "Yield" }),
    h({ ticker: "POLY-ABC-0", chain: "polymarket", protocol_section: "Prediction" }),
    h({ ticker: "METEORA-LP", chain: "solana-defi" }),
    h({ ticker: "KAMINO-MULTIPLY", chain: "solana-defi" }),
    h({ ticker: "ETH", chain: "base", source: "auto_defi" }),
  ]) {
    assert.equal(isPositionValue(x), true, x.ticker);
    assert.equal(resolvePriceKey(x, maps), null, x.ticker);
  }
  assert.equal(resolvePriceKey(h({ ticker: "PUSD", chain: "polymarket", protocol_section: "Deposit" }), maps), "polymarket-usd");
});

test("Cosmos and manual rows use the coin they already carry; manual without one stays unpriced", () => {
  assert.equal(resolvePriceKey(h({ ticker: "ATOM", chain: "cosmoshub", source: "auto_cosmos", coingecko_id: "cosmos" }), maps), "cosmos");
  assert.equal(resolvePriceKey(h({ ticker: "DOG", source: "manual_qty", coingecko_id: "dog-go-to-the-moon-rune" }), maps), "dog-go-to-the-moon-rune");
  assert.equal(resolvePriceKey(h({ ticker: "BTC", source: "manual_qty" }), maps), null);
  assert.equal(resolvePriceKey(h({ ticker: "X", source: "manual_usd", coingecko_id: "bitcoin" }), maps), null);
});

test("exchange tickers that are a chain's native coin mean that coin, ahead of a wrong registry match", () => {
  const wrong: KeyMaps = {
    ...maps,
    venues: new Map([
      [venueKey("coinbase", "ETH"), "polygon-pos-bridged-weth-polygon-pos"],
      [venueKey("kraken", "SOL"), "base-bridged-sol-base"],
      [venueKey("coinbase", "DEGEN"), "degen-base"],
    ]),
  };
  const ex = (ticker: string, chain = "coinbase") => resolvePriceKey(h({ ticker, chain, source: "auto_exchange" }), wrong);
  assert.equal(ex("ETH"), "ethereum");
  assert.equal(ex("SOL", "kraken"), "solana");
  assert.equal(ex("AVAX"), "avalanche-2");
  assert.equal(ex("BTC", "gemini"), "bitcoin");
  assert.equal(ex("DEGEN"), "degen-base", "not a native symbol: the venue mapping stands");
  assert.equal(ex("USDC", "kraken"), "usd-coin");
  assert.equal(ex("USD", "gemini"), "fiat:USD");
});

test("NATIVE_BY_SYMBOL: one coin per symbol, no wrapped or ambiguous entries", () => {
  assert.equal(NATIVE_BY_SYMBOL.get("ETH"), "ethereum");
  assert.equal(NATIVE_BY_SYMBOL.has("WBTC"), false);
  for (const id of NATIVE_BY_SYMBOL.values()) assert.ok(!id.includes(":"));
});

test("a venue maps its ticker even when the row carries a contract (Polymarket PUSD)", () => {
  assert.equal(resolvePriceKey(h({ ticker: "PUSD", chain: "polymarket", contract: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", protocol_section: "Deposit" }), maps), "polymarket-usd");
});

test("Solana mints match the registry case-insensitively (its keys are lowercase), and jup: keys keep the real mint", () => {
  const reg: KeyMaps = { ...maps, registry: new Map([[contractKey("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), "usd-coin"]]) };
  assert.equal(resolvePriceKey(h({ ticker: "USDC", chain: "solana", contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), reg), "usd-coin");
  assert.equal(resolvePriceKey(h({ ticker: "X", chain: "solana", contract: "AbCdMint" }), reg), "jup:AbCdMint");
});

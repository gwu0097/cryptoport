import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCoinCopies } from "./coinCopies.ts";
import { consolidateLiquidStaking } from "./liquidStaking.ts";
import type { AssetGroup } from "./queries.ts";

const g = (tickerKey: string, ticker: string, price: number | null, total: number): AssetGroup =>
  ({ tickerKey, ticker, iconUrl: null, totalQty: price ? total / price : null, total, unpricedCount: 0, price, change24h: null, change1h: null, change7d: null, change30d: null, marketCap: null, coingeckoId: tickerKey, holdings: [] }) as AssetGroup;

test("every copy of USDC joins the real USDC row; USDT's join USDT", () => {
  const groups = [
    g("usd-coin", "USDC", 1, 18_513),
    g("bridged-usdc-polygon", "USDC", 0.9999, 90),
    g("usd-coin-ethereum-bridged", "USDC.E", 1.0, 104),
    g("bridged-usd-coin-base", "USDbC", 1.0, 20),
    g("wormhole-usdc", "USDCet", 1.0, 420),
    g("tether", "USDT", 1, 722),
    g("usdt0", "USDT0", 1, 47),
    g("ethereum", "ETH", 2500, 5000),
  ];
  const bases = resolveCoinCopies(groups);
  assert.deepEqual(Object.fromEntries(bases), {
    "bridged-usdc-polygon": "usd-coin",
    "usd-coin-ethereum-bridged": "usd-coin",
    "bridged-usd-coin-base": "usd-coin",
    "wormhole-usdc": "usd-coin",
    usdt0: "tether",
  });
  const merged = consolidateLiquidStaking(groups, bases);
  const usdc = merged.find((x) => x.tickerKey === "usd-coin")!;
  assert.equal(usdc.total, 18_513 + 90 + 104 + 20 + 420); // totals unchanged, only grouped
  assert.deepEqual(usdc.combinedTickers, ["USDC.E", "USDbC", "USDCet"]); // each other ticker once
  assert.equal(merged.reduce((s, x) => s + x.total, 0), groups.reduce((s, x) => s + x.total, 0));
});

test("a look-alike off its peg, another stablecoin, or an unpriced copy stays its own row", () => {
  const groups = [g("usd-coin", "USDC", 1, 100), g("depegged-usdc", "USDC.E", 0.9, 10), g("binance-usd", "BUSD", 1, 50), g("mystery", "USDC", null, 5), g("other-usdc", "USDC", 0.95, 5)];
  assert.equal(resolveCoinCopies(groups).size, 0);
});

test("any coin's per-chain copies join at the same price (16 WETH rows → one); a namesake at another price doesn't", () => {
  const groups = [
    g("weth", "WETH", 2429.5, 2430),
    g("arbitrum-bridged-weth-arbitrum-one", "WETH", 2429.5, 300),
    g("polygon-pos-bridged-weth-polygon-pos", "WETH", 2431, 44),
    g("ethereum", "ETH", 2429.0, 5000), // not WETH: liquid staking or a later step decides that
    g("pepe-on-sol", "PEPE", 0.00002, 10),
    g("pepe", "PEPE", 0.000009, 900), // a different PEPE: same ticker, other price
  ];
  assert.deepEqual(Object.fromEntries(resolveCoinCopies(groups)), {
    "arbitrum-bridged-weth-arbitrum-one": "weth",
    "polygon-pos-bridged-weth-polygon-pos": "weth",
  });
});

test("without the real coin held, copies join the largest copy", () => {
  const groups = [g("bridged-a", "USDC", 1, 30), g("bridged-b", "USDC.E", 1, 70)];
  assert.deepEqual(Object.fromEntries(resolveCoinCopies(groups)), { "bridged-a": "bridged-b" });
});

test("rows liquid staking already took are left alone", () => {
  const groups = [g("usd-coin", "USDC", 1, 100), g("bridged-a", "USDC", 1, 30)];
  assert.equal(resolveCoinCopies(groups, new Set(["bridged-a"])).size, 0);
});

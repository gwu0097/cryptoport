import test from "node:test";
import assert from "node:assert/strict";
import { asterHoldings, asterMargin, baseAsset, type AsterBalance } from "./aster.ts";

// Shaped like Aster's documented aster_getBalance response (asterdex api docs).
const ACCOUNT: AsterBalance = {
  address: "0x69",
  accountPrivacy: "disabled",
  perpAssets: [
    { asset: "USDT", walletBalance: 1000 },
    { asset: "ASTER", walletBalance: "500" },
  ],
  positions: [
    {
      tradingProduct: "perps",
      positions: [
        { symbol: "BTCUSDT", collateral: "USDT", positionAmount: "0.01", entryPrice: "80000", unrealizedProfit: "40", notionalValue: "840", markPrice: "84000", leverage: 10, isolated: false, isolatedWallet: "0", positionSide: "BOTH" },
        { symbol: "ETHUSD1", collateral: "USD1", positionAmount: "-1", entryPrice: "2700", unrealizedProfit: "-10", notionalValue: "2710", leverage: 5, isolated: true, isolatedWallet: "600", positionSide: "BOTH" },
        { symbol: "SOLUSDT", positionAmount: "0", entryPrice: "0", unrealizedProfit: "0", notionalValue: "0", leverage: 20, isolated: false, isolatedWallet: "0" },
      ],
    },
  ],
  staking: { totalStakedAmount: "125", totalUnclaimedRewards: [{ asset: "ASTER", amount: "3.5" }] },
};

test("base asset from the symbol, quote by collateral or a known dollar quote", () => {
  assert.equal(baseAsset({ symbol: "BTCUSDT", collateral: "USDT" }), "BTC");
  assert.equal(baseAsset({ symbol: "ETHUSD1" }), "ETH");
  assert.equal(baseAsset({ symbol: "1000PEPEUSDT" }), "1000PEPE");
});

test("margin: isolated → its wallet, cross → notional ÷ leverage", () => {
  assert.equal(asterMargin(ACCOUNT.positions![0].positions[0]), 84);
  assert.equal(asterMargin(ACCOUNT.positions![0].positions[1]), 600);
});

test("dollar rows add up to the account's dollar equity once (wallet + PnL)", () => {
  const { holdings, warnings } = asterHoldings(ACCOUNT);
  assert.deepEqual(warnings, []);
  const dollars = holdings.filter((h) => h.usd_override !== null).reduce((s, h) => s + (h.usd_override as number), 0);
  assert.ok(Math.abs(dollars - (1000 + 40 - 10)) < 1e-9);
  const perps = holdings.filter((h) => h.position_side);
  assert.deepEqual(perps.map((h) => [h.ticker, h.contract, h.position_side, h.qty]), [
    ["BTC-PERP", "BTCUSDT", "long", 0.01],
    ["ETH-PERP", "ETHUSD1", "short", 1],
  ]);
});

test("other collateral, staking and rewards are coin rows priced by their coin", () => {
  const { holdings } = asterHoldings(ACCOUNT);
  const coinRows = holdings.filter((h) => h.usd_override === null).map((h) => [h.ticker, h.protocol_section, h.qty, h.coingecko_id]);
  assert.deepEqual(coinRows, [
    ["ASTER", "Deposit", 500, "aster-2"],
    ["ASTER", "Staked", 125, "aster-2"],
    ["ASTER", "Rewards", 3.5, "aster-2"],
  ]);
});

test("privacy mode is flagged, not shown as an empty account", () => {
  assert.equal(asterHoldings({ address: "0x1", accountPrivacy: "enabled" }).warnings.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { perpAccountRows, perpsUnallocatedUsd } from "./hyperliquidPerps.ts";

test("open positions' margin isn't counted again as available (live account, 2026-09-25)", () => {
  // accountValue 4678.130609 = withdrawable 0.849007 + margins 1591.086112 + 1582.53024 + 1503.66525
  assert.equal(perpsUnallocatedUsd(4678.130609, 0.849007, [1591.086112, 1582.53024, 1503.66525]), null);
});

test("equity not in a position or withdrawable is shown once", () => {
  const rest = perpsUnallocatedUsd(1000, 200, [500])!;
  assert.ok(Math.abs(rest - 300) < 1e-9);
});

test("no positions: nothing beyond withdrawable", () => {
  assert.equal(perpsUnallocatedUsd(250, 250, []), null);
  assert.equal(perpsUnallocatedUsd(NaN, 0, []), null);
});

const pos = (coin: string, szi: string, marginUsed: string, extra: Partial<Record<string, string>> = {}) => ({
  type: "oneWay",
  position: { coin, szi, entryPx: "100", liquidationPx: null, unrealizedPnl: "5", marginUsed, leverage: { type: "cross", value: 5 }, returnOnEquity: "0.01", ...extra },
});

test("perpAccountRows: main market rows add up to the account value once", () => {
  const rows = perpAccountRows({ marginSummary: { accountValue: "1000" }, crossMarginSummary: { accountValue: "1000" }, withdrawable: "200", assetPositions: [pos("LIT", "10", "500"), pos("PONS", "-3", "100")] }, "USDC", null);
  assert.deepEqual(rows.map((r) => [r.ticker, r.display_label, r.usd_override]), [
    ["USDC", "Perps Withdrawable", 200],
    ["USDC", "Perps Available", 200],
    ["LIT-PERP", null, 500],
    ["PONS-PERP", null, 100],
  ]);
  assert.equal(rows.reduce((s, r) => s + (r.usd_override as number), 0), 1000);
  assert.equal(rows[3].position_side, "short");
});

test("perpAccountRows: a HIP-3 market's rows are labeled with it and held in its collateral", () => {
  const rows = perpAccountRows({ marginSummary: { accountValue: "5492.31" }, crossMarginSummary: { accountValue: "5492.31" }, withdrawable: "13.99", assetPositions: [pos("xyz:TSLA", "2", "5478.32")] }, "USDH", { label: "XYZ" });
  assert.deepEqual(rows.map((r) => [r.ticker, r.display_label]), [
    ["USDH", "XYZ · Withdrawable"],
    ["xyz:TSLA-PERP", "XYZ"],
  ]);
  assert.ok(Math.abs(rows.reduce((s, r) => s + (r.usd_override as number), 0) - 5492.31) < 1e-6);
});

test("perpAccountRows: collateral that isn't a listed stablecoin stays unpriced, never 1:1", () => {
  const rows = perpAccountRows({ marginSummary: { accountValue: "10" }, crossMarginSummary: { accountValue: "10" }, withdrawable: "10", assetPositions: [] }, "HYPE", { label: "X" });
  assert.equal(rows[0].usd_override, null);
});

test("perpAccountRows: an isolated position's margin is inside the whole account value, not cross's", () => {
  // cross equity 400 (withdrawable 100 + 300 unallocated), one isolated position with 600 margin
  const rows = perpAccountRows({ marginSummary: { accountValue: "1000" }, crossMarginSummary: { accountValue: "400" }, withdrawable: "100", assetPositions: [pos("xyz:TSLA", "1", "600")] }, "USDC", { label: "XYZ" });
  assert.equal(rows.reduce((s, r) => s + (r.usd_override as number), 0), 1000);
});

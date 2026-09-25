import test from "node:test";
import assert from "node:assert/strict";
import { perpsUnallocatedUsd } from "./hyperliquidPerps.ts";

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

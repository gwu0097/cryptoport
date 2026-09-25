import { test } from "node:test";
import assert from "node:assert/strict";
import { gapCause, isCoinHolding, isLockedOnPurpose, type CoverageHolding } from "./pricingCoverage.ts";
import { SEI_LOCKED_NOTE } from "./seiLock.ts";

const h = (over: Partial<CoverageHolding>): CoverageHolding => ({ ticker: "X", chain: "eth", contract: null, source: "auto", price_key: null, ...over });
const prices = new Map([
  ["ethereum", { usd: 4000, missing_since: null }],
  ["dropped", { usd: null, missing_since: "2026-09-20T00:00:00Z" }],
]);

test("priced holdings are not gaps", () => {
  assert.equal(gapCause(h({ price_key: "ethereum" }), prices), null);
});

test("keyed but unpriced: never priced vs. source dropped it", () => {
  assert.equal(gapCause(h({ price_key: "new-coin" }), prices), "not-priced-yet");
  assert.equal(gapCause(h({ price_key: "dropped" }), prices), "source-dropped");
});

test("no key, by cause", () => {
  assert.equal(gapCause(h({ chain: "kraken", source: "auto_exchange", ticker: "XDG" }), prices), "exchange-ticker");
  assert.equal(gapCause(h({ chain: "cosmoshub", source: "auto_cosmos", ticker: "ibc/D41E…95C8" }), prices), "cosmos-ibc");
  assert.equal(gapCause(h({ chain: "osmosis", source: "auto_cosmos", ticker: "BADKID" }), prices), "cosmos-token");
  assert.equal(gapCause(h({ contract: "0xabc" }), prices), "unlisted-contract");
  assert.equal(gapCause(h({ chain: "neo", ticker: "GAS" }), prices), "unmatched-native");
  assert.equal(gapCause(h({ chain: null, source: "manual_qty" }), prices), "no-coin-picked");
});

test("positions and dollar-only rows are not coin holdings", () => {
  assert.equal(isCoinHolding(h({ ticker: "ETH-PERP" })), false);
  assert.equal(isCoinHolding(h({ source: "manual_usd" })), false);
  assert.equal(isCoinHolding(h({ ticker: "ETH" })), true);
});

test("coins locked on purpose are recognized", () => {
  assert.equal(isLockedOnPurpose(h({ chain: "sei", display_label: `SEI — ${SEI_LOCKED_NOTE}` })), true);
  assert.equal(isLockedOnPurpose(h({ chain: "sei", display_label: null })), false);
});

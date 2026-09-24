import test from "node:test";
import assert from "node:assert/strict";
import { naviPositionsToHoldings } from "./naviPositions.ts";

const VSUI = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";

test("the Ledger wallet's real supply: 303.03 vSUI valued at its own price (not the SDK's SUI-priced valueUSD)", () => {
  const { holdings, unpriced } = naviPositionsToHoldings([
    {
      type: "navi-lending-supply",
      "navi-lending-supply": { amount: "303.034081861", valueUSD: "305.77540695437588986", token: { coinType: VSUI, symbol: "vSUI", price: 1.083, logoUri: "https://x/vsui.png" } },
    },
  ]);
  assert.deepEqual(unpriced, []);
  assert.equal(holdings.length, 1);
  const h = holdings[0];
  assert.equal(h.ticker, "VSUI");
  assert.equal(h.qty, 303.034081861);
  assert.equal(Math.round(h.usd_override * 100) / 100, 328.19);
  assert.equal(h.contract, VSUI);
  assert.equal(h.protocol_section, "Supplied");
});

test("with a borrow: one net row (supplied − borrowed), never a negative debt row", () => {
  const { holdings } = naviPositionsToHoldings([
    { type: "navi-lending-supply", "navi-lending-supply": { amount: "100", token: { symbol: "SUI", price: 1 } } },
    { type: "navi-lending-borrow", "navi-lending-borrow": { amount: "30", token: { symbol: "USDC", price: 1 } } },
  ]);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].usd_override, 70);
  assert.equal(holdings[0].qty, null);
  assert.match(holdings[0].display_label!, /supplied 100 SUI − borrowed 30 USDC/);
});

test("a leg without a price is reported, not valued at 0; unknown types and zero amounts are skipped", () => {
  const { holdings, unpriced } = naviPositionsToHoldings([
    { type: "navi-lending-supply", "navi-lending-supply": { amount: "5", token: { symbol: "ODD" } } },
    { type: "navi-lending-supply", "navi-lending-supply": { amount: "0", token: { symbol: "SUI", price: 1 } } },
    { type: "navi-other", "navi-other": {} },
  ]);
  assert.deepEqual(holdings, []);
  assert.deepEqual(unpriced, ["supply ODD"]);
});

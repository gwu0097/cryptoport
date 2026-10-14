import test from "node:test";
import assert from "node:assert/strict";
import { knownDestination } from "./knownDestinations.ts";

test("Hyperliquid's Arbitrum bridge and CCTP deposit contract are named, in any case", () => {
  assert.equal(knownDestination("0x2df1c51e09aecf9cacb7bc98cb1742757f163df7"), "Hyperliquid");
  assert.equal(knownDestination("0xA95D9C1F655341597C94393FDDC30CF3C08E4FCE"), "Hyperliquid");
});

test("any other address, or none, is not a known destination", () => {
  assert.equal(knownDestination("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"), null);
  assert.equal(knownDestination(null), null);
  assert.equal(knownDestination(""), null);
});

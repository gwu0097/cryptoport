import test from "node:test";
import assert from "node:assert/strict";
import { chainDisplayName, defaultChainId } from "./chainNames.ts";

test("defaultChainId maps every non-EVM auto-capable chain to its adapter-native slug", () => {
  assert.equal(defaultChainId("BTC"), "bitcoin");
  assert.equal(defaultChainId("SOL"), "solana");
  assert.equal(defaultChainId("ADA"), "cardano");
  assert.equal(defaultChainId("ATOM"), "cosmoshub");
  assert.equal(defaultChainId("INJ"), "injective");
  assert.equal(defaultChainId("NEAR"), "near");
  assert.equal(defaultChainId("SUI"), "sui");
  assert.equal(defaultChainId("FIL"), "filecoin");
  assert.equal(defaultChainId("BCH"), "bitcoincash");
  assert.equal(defaultChainId("DOT"), "polkadot");
  assert.equal(defaultChainId("TAO"), "bittensor");
  assert.equal(defaultChainId("XRP"), "xrpl");
  assert.equal(defaultChainId("APT"), "aptos");
  assert.equal(defaultChainId("ICP"), "internet-computer");
});

// Regression test: defaultChainId used to have no explicit case for NEO or
// TON at all, and only "worked" because their uppercase ticker happens to
// coincidentally lowercase into their real chain id — unlike XRP, which
// needed (and still needs) an explicit mapping because "XRP".toLowerCase()
// is "xrp", not the real chain id "xrpl". Pinning these two down so a
// future chain whose ticker doesn't coincidentally lowercase correctly
// can't silently repeat the same gap.
test("defaultChainId maps NEO and TON correctly, not just by lowercase coincidence", () => {
  assert.equal(defaultChainId("NEO"), "neo");
  assert.equal(defaultChainId("TON"), "ton");
});

test("defaultChainId falls back to lowercasing an EVM chain label", () => {
  assert.equal(defaultChainId("ETH"), "eth");
  assert.equal(defaultChainId("RON"), "ron");
});

test("defaultChainId falls back to lowercasing an unrecognized manual-only chain", () => {
  assert.equal(defaultChainId("SOMECHAIN"), "somechain");
});

test("chainDisplayName resolves both a wallet's uppercase chain and a holding's adapter-native slug to the same name", () => {
  assert.equal(chainDisplayName("NEO"), "NEO");
  assert.equal(chainDisplayName("neo"), "NEO");
  assert.equal(chainDisplayName("XRP"), "XRP Ledger");
  assert.equal(chainDisplayName("xrpl"), "XRP Ledger");
});

test("chainDisplayName falls back to the raw id for an unrecognized chain", () => {
  assert.equal(chainDisplayName("somechain"), "somechain");
});

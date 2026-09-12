import test from "node:test";
import assert from "node:assert/strict";
import {
  generateSyntheticEmail,
  isSyntheticEmail,
  pinnedWalletChain,
  truncateAddress,
  walletDisplayName,
  type WalletChain,
} from "./walletDisplay.ts";

test("isSyntheticEmail accepts the reserved wallet domain", () => {
  assert.equal(isSyntheticEmail(generateSyntheticEmail()), true);
});

test("isSyntheticEmail rejects a real email", () => {
  assert.equal(isSyntheticEmail("thunderclapper3@gmail.com"), false);
});

test("generateSyntheticEmail produces a different address each time", () => {
  assert.notEqual(generateSyntheticEmail(), generateSyntheticEmail());
});

test("truncateAddress shows first5…last5 for a long value", () => {
  assert.equal(truncateAddress("0x3afd68ecac6581cde82318d0781a50006eaa41e9"), "0x3af…a41e9");
});

test("truncateAddress leaves a short value untouched", () => {
  assert.equal(truncateAddress("0xabc"), "0xabc");
});

test("walletDisplayName returns null for a real-email account", () => {
  assert.equal(walletDisplayName({ email: "thunderclapper3@gmail.com" }), null);
});

test("walletDisplayName truncates the linked address for a wallet-only account", () => {
  const email = generateSyntheticEmail();
  const address = "0x3afd68ecac6581cde82318d0781a50006eaa41e9";
  assert.equal(
    walletDisplayName({ email, user_metadata: { wallet_chain: "ETH" as WalletChain, wallet_address: address } }),
    truncateAddress(address),
  );
});

test("pinnedWalletChain maps every configured EVM chain id to ETH", () => {
  for (const chain of ["ETH", "RON", "SEI", "ARB", "eth", "ron"]) {
    assert.equal(pinnedWalletChain(chain), "ETH");
  }
});

test("pinnedWalletChain maps SOL to itself", () => {
  assert.equal(pinnedWalletChain("SOL"), "SOL");
});

test("pinnedWalletChain returns null for a chain with no wallet-auth scheme", () => {
  assert.equal(pinnedWalletChain("BTC"), null);
  assert.equal(pinnedWalletChain("ADA"), null);
});

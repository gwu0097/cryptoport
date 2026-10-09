import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateOf, type WalletKey } from "./walletDuplicates.ts";

const isEvm = (c: string) => ["ETH", "ARB", "BASE"].includes(c.toUpperCase());
const wallets: WalletKey[] = [
  { id: "1", name: "BizCash", chain: "ETH", address: "0xB3Fe5A7c926e85b6e451c03876011Cd3B6513A80" },
  { id: "2", name: "Phantom", chain: "SOL", address: "4a7NWcurNg4ynBk2U8ujhHW2evCjp3LmEkeEHsiPDCTs" },
];

test("the same EVM address is a duplicate whatever its case or EVM chain label (BizCash, 2026-10-09)", () => {
  assert.equal(duplicateOf({ chain: "ETH", address: "0xb3fe5a7c926e85b6e451c03876011cd3b6513a80" }, wallets, isEvm)?.name, "BizCash");
  assert.equal(duplicateOf({ chain: "ARB", address: "0xB3Fe5A7c926e85b6e451c03876011Cd3B6513A80" }, wallets, isEvm)?.name, "BizCash");
});

test("other chains compare exactly and only on the same chain", () => {
  assert.equal(duplicateOf({ chain: "SOL", address: "4a7NWcurNg4ynBk2U8ujhHW2evCjp3LmEkeEHsiPDCTs" }, wallets, isEvm)?.name, "Phantom");
  assert.equal(duplicateOf({ chain: "SOL", address: "4a7nwcurng4ynbk2u8ujhhw2evcjp3lmekeehsipdcts" }, wallets, isEvm), null);
  assert.equal(duplicateOf({ chain: "SUI", address: "4a7NWcurNg4ynBk2U8ujhHW2evCjp3LmEkeEHsiPDCTs" }, wallets, isEvm), null);
});

test("editing a wallet doesn't flag itself; no address, no duplicate", () => {
  assert.equal(duplicateOf({ chain: "ETH", address: "0xB3Fe5A7c926e85b6e451c03876011Cd3B6513A80" }, wallets, isEvm, "1"), null);
  assert.equal(duplicateOf({ chain: "ETH", address: null }, wallets, isEvm), null);
});

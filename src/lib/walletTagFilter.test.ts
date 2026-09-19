import test from "node:test";
import assert from "node:assert/strict";
import { filterWalletsByTags } from "./walletTagFilter.ts";

function wallet(id: string, tagNames: string[]) {
  return { id, tags: tagNames.map((name) => ({ name })) };
}

test("filterWalletsByTags returns every wallet when no tags are selected", () => {
  const wallets = [wallet("a", ["Biz"]), wallet("b", [])];
  assert.deepEqual(filterWalletsByTags(wallets, []), wallets);
});

test("filterWalletsByTags keeps only wallets carrying every selected tag (AND, not OR)", () => {
  const wallets = [
    wallet("a", ["Main", "Soft Wallet"]),
    wallet("b", ["Main"]),
    wallet("c", ["Soft Wallet"]),
    wallet("d", []),
  ];
  assert.deepEqual(
    filterWalletsByTags(wallets, ["Main", "Soft Wallet"]).map((w) => w.id),
    ["a"],
  );
});

test("filterWalletsByTags with a single selected tag matches any wallet carrying it", () => {
  const wallets = [wallet("a", ["Main"]), wallet("b", ["Biz"]), wallet("c", ["Main", "Biz"])];
  assert.deepEqual(filterWalletsByTags(wallets, ["Main"]).map((w) => w.id), ["a", "c"]);
});

test("filterWalletsByTags returns an empty array when nothing matches", () => {
  const wallets = [wallet("a", ["Biz"])];
  assert.deepEqual(filterWalletsByTags(wallets, ["Main"]), []);
});

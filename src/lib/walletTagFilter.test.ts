import test from "node:test";
import assert from "node:assert/strict";
import { filterWalletsByTags, matchesWalletSearch, filterWallets } from "./walletTagFilter.ts";

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

test("matchesWalletSearch: case-insensitive, across name/chain/address/notes/tags; terms are ANDed", () => {
  const w = { name: "Ledger Solana - Biz", chain: "SOL", address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", notes: "cold storage", tags: [{ name: "Hard Wallet" }] };
  assert.equal(matchesWalletSearch(w, "ledger"), true);
  assert.equal(matchesWalletSearch(w, "LEDGER sol"), true, "two terms, both present");
  assert.equal(matchesWalletSearch(w, "ledger eth"), false, "every term must match");
  assert.equal(matchesWalletSearch(w, "9xqewv"), true, "address prefix, any case");
  assert.equal(matchesWalletSearch(w, "hard wallet"), true, "tag names");
  assert.equal(matchesWalletSearch(w, "cold"), true, "notes");
  assert.equal(matchesWalletSearch(w, "   "), true, "blank query matches everything");
  assert.equal(matchesWalletSearch({ name: "BTC", chain: "BTC", address: null, tags: [] }, "0x"), false, "a null address never matches");
});

test("filterWallets combines the tag filter (AND) and the search", () => {
  const ws = [
    { id: "a", name: "Metamask Main", chain: "ETH", address: "0xabc", tags: [{ name: "Main" }] },
    { id: "b", name: "Phantom Sol", chain: "SOL", address: "Ph4n", tags: [{ name: "Main" }] },
    { id: "c", name: "Rabby ETH", chain: "ETH", address: "0xdef", tags: [] },
  ];
  assert.deepEqual(filterWallets(ws, { tags: ["Main"], query: "eth" }).map((w) => w.id), ["a"]);
  assert.deepEqual(filterWallets(ws, { tags: [], query: "eth" }).map((w) => w.id), ["a", "c"]);
  assert.deepEqual(filterWallets(ws, { tags: [], query: "" }).map((w) => w.id), ["a", "b", "c"]);
});

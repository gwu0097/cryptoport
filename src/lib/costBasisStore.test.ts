import { test } from "node:test";
import assert from "node:assert/strict";
import { costBasisSettingKey, holdingChangedSince, savedForToken } from "./costBasisStore.ts";
import type { CostBasisRow } from "./costBasis.ts";

const row = (holdingQty: number | null): CostBasisRow => ({ avgCost: 1, costUsd: 1, costedQty: 1, unknownQty: 0, buys: 1, firstBuyAt: null, chain: "base", chainName: "Base", holdingQty, firstSeenAt: null, partial: false });

test("saved rows are read back by wallet, only this user's and this exact coin's", () => {
  const saved = { results: [row(5)], computedAt: "2026-10-14T00:00:00Z" };
  const rows = [
    { key: costBasisSettingKey("u1", "w1", "jup:Mint_1"), value: saved },
    { key: costBasisSettingKey("u1", "w2", "jup:MintX1"), value: saved }, // `_` matched it in LIKE
    { key: costBasisSettingKey("u2", "w3", "jup:Mint_1"), value: saved },
    { key: costBasisSettingKey("u1", "w4", "jup:Mint_1"), value: { junk: true } },
  ];
  assert.deepEqual(Object.keys(savedForToken(rows, "u1", "jup:Mint_1")), ["w1"]);
});

test("a holding that changed since asks for a refresh; unknown makes no claim", () => {
  const s = { results: [row(5), row(2)], computedAt: "x" };
  assert.equal(holdingChangedSince(s, 7), false);
  assert.equal(holdingChangedSince(s, 9), true);
  assert.equal(holdingChangedSince(s, null), false);
  assert.equal(holdingChangedSince({ results: [row(null)], computedAt: "x" }, 3), false);
});

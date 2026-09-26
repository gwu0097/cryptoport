import test from "node:test";
import assert from "node:assert/strict";
import { txSourcesFor, txSyncStatus } from "./transactionSources.ts";

const covered = { alchemy: new Set(["base", "eth"]), etherscan: new Set(["eth", "taiko"]), blockscout: new Set(["base", "mode"]) };

test("sources in order: Alchemy, then Etherscan, then Blockscout; none for an uncovered chain", () => {
  assert.deepEqual(txSourcesFor("eth", covered), ["alchemy", "etherscan"]);
  assert.deepEqual(txSourcesFor("base", covered), ["alchemy", "blockscout"]);
  assert.deepEqual(txSourcesFor("taiko", covered), ["etherscan"]);
  assert.deepEqual(txSourcesFor("chiliz", covered), []);
});

test("status: ok, ok with uncovered chains named, partial when a chain's history was kept", () => {
  assert.equal(txSyncStatus(12, [], []), "ok (12)");
  assert.equal(txSyncStatus(12, [], ["chiliz"]), "ok (12) · no history source for chiliz");
  const s = txSyncStatus(12, [{ chain: "taiko", error: "Etherscan: rate limited" }], []);
  assert.ok(s.startsWith("partial — 12 saved; kept from last sync: taiko (Etherscan: rate limited)"));
});

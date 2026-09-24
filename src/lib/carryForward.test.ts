import test from "node:test";
import assert from "node:assert/strict";
import { carryForward, keptNote, chainScope, protocolScope, type KeepableRow } from "./carryForward.ts";

const row = (o: Partial<KeepableRow> & { ticker: string }): KeepableRow => ({ chain: "ron", contract: null, category: "token", ...o });

const axieStaked = row({ ticker: "AXS", contract: "0xaxs", category: "defi", protocol: "Axie Staking" });
const axieRewards = row({ ticker: "AXS", contract: "0xaxs", category: "defi", protocol: "Axie Staking Rewards" });
const ron = row({ ticker: "RON" });
const weth = row({ ticker: "WETH", contract: "0xweth" });

test("a failed source's previous rows are re-saved; everything else comes only from this sync", () => {
  const fresh = [ron, weth];
  const { holdings, kept } = carryForward(fresh, [ron, weth, axieStaked, axieRewards], [protocolScope("axie staking", "Axie Staking")]);
  assert.deepEqual(holdings, [ron, weth, axieStaked, axieRewards]);
  assert.deepEqual(kept, [{ label: "axie staking", count: 2 }]);
  assert.equal(keptNote(kept), "kept from the last sync, not refreshed: axie staking (2 rows)");
});

test("no failed scope = exactly this sync's rows (a closed position really disappears)", () => {
  const { holdings, kept } = carryForward([ron], [ron, axieStaked], []);
  assert.deepEqual(holdings, [ron]);
  assert.deepEqual(kept, []);
  assert.equal(keptNote(kept), "");
});

test("a position this sync already produced fresh is never duplicated by its old copy", () => {
  const freshRon = { ...ron, qty: 60 } as KeepableRow;
  const oldRon = { ...ron, qty: 54 } as KeepableRow;
  const { holdings, kept } = carryForward([freshRon], [oldRon, weth], [chainScope("ron", "ron")]);
  assert.deepEqual(holdings, [freshRon, weth]);
  assert.deepEqual(kept, [{ label: "ron", count: 1 }]);
});

test("a row matched by two failed scopes is kept once", () => {
  const { holdings } = carryForward([], [axieStaked], [chainScope("ron", "ron"), protocolScope("axie", "Axie Staking")]);
  assert.deepEqual(holdings, [axieStaked]);
});

test("protocolScope matches the exact name or a 'Name ' / 'Name:' prefix, not a longer word", () => {
  const s = protocolScope("x", "Lulo", "Solana Staking", "Navi");
  assert.ok(s.owns(row({ ticker: "USDC", protocol: "Lulo: Protected" })));
  assert.ok(s.owns(row({ ticker: "SOL", protocol: "Solana Staking: Helius" })));
  assert.ok(s.owns(row({ ticker: "SUI", protocol: "Navi" })));
  assert.ok(!s.owns(row({ ticker: "X", protocol: "Navigator" })));
  assert.ok(!s.owns(row({ ticker: "X", protocol: null })));
});

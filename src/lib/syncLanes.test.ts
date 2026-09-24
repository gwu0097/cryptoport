import test from "node:test";
import assert from "node:assert/strict";
import { syncLane, groupByLane } from "./syncLanes.ts";

const isEvm = (c: string) => ["ETH", "RON", "BASE", "SEI"].includes(c);
const w = (chain: string, address: string | null = "0xabc", provider: string | null = null) => ({ chain, address, provider });

test("every 0x wallet shares the EVM lane, whatever its chain label", () => {
  assert.equal(syncLane(w("ETH"), isEvm), "evm");
  assert.equal(syncLane(w("RON"), isEvm), "evm");
  assert.equal(syncLane(w("SEI"), isEvm), "evm");
  assert.equal(syncLane(w("SEI", "sei1abc"), isEvm), "cosmos");
});

test("Solana, Cosmos, exchanges and single-API chains get their own lanes", () => {
  assert.equal(syncLane(w("SOL", "Abc"), isEvm), "solana");
  assert.equal(syncLane(w("ATOM", "cosmos1"), isEvm), "cosmos");
  assert.equal(syncLane(w("COINBASE", null, "coinbase"), isEvm), "exchange:coinbase");
  assert.equal(syncLane(w("SUI", "0x1"), isEvm), "SUI");
  assert.equal(syncLane(w("btc", "bc1"), isEvm), "BTC");
});

test("groupByLane keeps order within a lane", () => {
  assert.deepEqual(groupByLane(["e1", "s1", "e2", "b1", "s2"], (x) => x[0]), [["e1", "e2"], ["s1", "s2"], ["b1"]]);
});

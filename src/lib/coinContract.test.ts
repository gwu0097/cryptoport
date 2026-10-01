import test from "node:test";
import assert from "node:assert/strict";
import { pickContract } from "./coinContract.ts";

test("a coin on many chains copies its home chain's contract; none for a native coin", () => {
  assert.deepEqual(pickContract([{ chain_id: "arb", contract: "0xa" }, { chain_id: "solana", contract: "Sol1" }, { chain_id: "eth", contract: "0xe" }]), { chain: "eth", contract: "0xe" });
  assert.deepEqual(pickContract([{ chain_id: "zksync", contract: "0xz" }, { chain_id: "blast", contract: "0xb" }]), { chain: "blast", contract: "0xb" });
  assert.equal(pickContract([]), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { copyableContracts, ownContract } from "./coinContracts.ts";

const A = "0x" + "a".repeat(40);

test("a jup: coin copies its own mint, case kept", () => {
  assert.deepEqual(ownContract("jup:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), { chainId: "solana", chainName: "Solana", contract: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" });
  assert.equal(ownContract("bitcoin"), null);
  assert.equal(ownContract("jup:not-a-mint"), null);
});

test("registry rows: EVM only (a lowercased mint is a wrong address), Ethereum first, once each", () => {
  const out = copyableContracts([
    { chain_id: "base", contract: A },
    { chain_id: "solana", contract: "dezxaz8z7pnrnrjjz3wxborgixca6xjnb7yab1ppb263" },
    { chain_id: "eth", contract: A },
    { chain_id: "eth", contract: A },
  ]);
  assert.deepEqual(out.map((c) => c.chainId), ["eth", "base"]);
  assert.equal(out[0].chainName, "Ethereum");
});

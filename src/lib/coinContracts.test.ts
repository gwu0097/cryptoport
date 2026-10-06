import test from "node:test";
import assert from "node:assert/strict";
import { copyableContracts, ownContract } from "./coinContracts.ts";

const A = "0x" + "a".repeat(40);

test("a jup: coin copies its own mint, case kept", () => {
  assert.deepEqual(ownContract("jup:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), { chainId: "solana", chainName: "Solana", contract: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" });
  assert.equal(ownContract("bitcoin"), null);
  assert.equal(ownContract("jup:not-a-mint"), null);
});

test("registry rows: EVM, and Solana only with its exact address; Ethereum first among EVM, once each", () => {
  const out = copyableContracts([
    { chain_id: "base", contract: A },
    { chain_id: "solana", contract: "dezxaz8z7pnrnrjjz3wxborgixca6xjnb7yab1ppb263" },
    { chain_id: "eth", contract: A },
    { chain_id: "eth", contract: A },
  ]);
  assert.deepEqual(out.map((c) => c.chainId), ["eth", "base"]);
  assert.equal(out[0].chainName, "Ethereum");
});

test("a Solana or Sui row is offered only with its address as written", () => {
  const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const sui = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";
  const out = copyableContracts([
    { chain_id: "eth", contract: A },
    { chain_id: "sui", contract: sui.toLowerCase(), contract_exact: sui },
    { chain_id: "solana", contract: mint.toLowerCase(), contract_exact: mint },
    { chain_id: "solana", contract: "other", contract_exact: mint },
  ]);
  assert.deepEqual(out.map((c) => [c.chainId, c.contract]), [["solana", mint], ["eth", A], ["sui", sui]]);
});

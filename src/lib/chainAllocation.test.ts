import test from "node:test";
import assert from "node:assert/strict";
import { assetTypeOf, chainAllocations, topChains, type AllocationHolding } from "./chainAllocation.ts";

const h = (o: Partial<AllocationHolding> & { usd?: number }): AllocationHolding => ({
  chainId: "ron",
  chainName: "Ronin",
  category: "token",
  protocol: null,
  protocol_section: null,
  valuation: o.usd === undefined ? { kind: "unpriced" } : { kind: "priced", usd: o.usd },
  ...o,
});

test("asset type comes from the category, section and protocol names the adapters write", () => {
  assert.equal(assetTypeOf(h({})), "Available");
  assert.equal(assetTypeOf(h({ category: "defi", protocol: "Axie Staking" })), "Staked");
  assert.equal(assetTypeOf(h({ category: "defi", protocol: "Axie Staking Rewards" })), "Rewards");
  assert.equal(assetTypeOf(h({ category: "defi", protocol: "Osmosis staking", protocol_section: "Unbonding" })), "Staked");
  assert.equal(assetTypeOf(h({ category: "defi", protocol: "Jito MEV Rewards: Helius" })), "Rewards");
  assert.equal(assetTypeOf(h({ category: "defi", protocol: "Hyperliquid", protocol_section: "Rewards" })), "Rewards");
  assert.equal(assetTypeOf(h({ category: "defi", protocol: "Kamino Lending" })), "DeFi");
  assert.equal(assetTypeOf(h({ category: "defi", protocol: "Hyperliquid", protocol_section: "Yield" })), "DeFi");
});

test("per-chain totals split by type, richest first; unpriced counted, never valued", () => {
  const out = chainAllocations([
    h({ usd: 3.3 }),
    h({ category: "defi", protocol: "Axie Staking", usd: 400 }),
    h({ category: "defi", protocol: "Axie Staking Rewards", usd: 60 }),
    h({}),
    h({ chainId: "eth", chainName: "Ethereum", usd: 1000 }),
  ]);
  assert.deepEqual(out.map((c) => [c.chainId, c.total, c.unpricedCount]), [["eth", 1000, 0], ["ron", 463.3, 1]]);
  assert.deepEqual(out[1].byType, { Available: 3.3, Staked: 400, Rewards: 60, DeFi: 0 });
});

test("Solana DeFi positions count toward Solana", () => {
  const out = chainAllocations([
    h({ chainId: "solana-defi", chainName: "Solana DeFi", category: "defi", protocol: "Kamino Lending", usd: 50 }),
    h({ chainId: "solana", chainName: "Solana", usd: 20 }),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].chainId, out[0].chainName, out[0].total, out[0].byType.DeFi], ["solana", "Solana", 70, 50]);
});

test("top N plus the rest; value-less chains are in neither", () => {
  const all = chainAllocations([
    h({ chainId: "a", chainName: "A", usd: 5 }),
    h({ chainId: "b", chainName: "B", usd: 4 }),
    h({ chainId: "c", chainName: "C", usd: 3 }),
    h({ chainId: "d", chainName: "D" }),
  ]);
  const { top, rest } = topChains(all, 2);
  assert.deepEqual(top.map((c) => c.chainId), ["a", "b"]);
  assert.deepEqual(rest.map((c) => c.chainId), ["c"]);
});

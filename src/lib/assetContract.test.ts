import { test } from "node:test";
import assert from "node:assert/strict";
import { assetContract, isTokenAddress } from "./assetContract.ts";

test("real token addresses only", () => {
  assert.ok(isTokenAddress("0x64b88c73a5dfa78d1713fe1b4c69a22d7e0faa00"));
  assert.ok(isTokenAddress("jucy5XJ76pHVvtPZb5TKRcGQExkwit2P5s4vY8Uz9ZR"));
  assert.ok(isTokenAddress("0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD"));
  for (const c of ["uakt", "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", "", null, undefined]) assert.equal(isTokenAddress(c), false);
});

test("the largest holding's address, and how many there are", () => {
  const priced = (usd: number) => ({ kind: "priced", usd });
  const got = assetContract([
    { contract: "0x1111111111111111111111111111111111111111", chainName: "Base", valuation: priced(5) },
    { contract: "0x2222222222222222222222222222222222222222", chainName: "Arbitrum", valuation: priced(50) },
    { contract: null, chainName: "Ethereum", valuation: priced(500) },
  ]);
  assert.deepEqual(got, { contract: "0x2222222222222222222222222222222222222222", chainName: "Arbitrum", distinct: 2 });
});

test("a native coin or a position has nothing to copy", () => {
  assert.equal(assetContract([{ contract: "uakt", chainName: "Akash", valuation: { kind: "unpriced" } }]), null);
  assert.equal(assetContract([]), null);
});

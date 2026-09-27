import test from "node:test";
import assert from "node:assert/strict";
import { claimBelievable, provenReceipt, type ProbeAnswers } from "./receiptChecks.ts";

const none: ProbeAnswers = { erc4626: null, aave: null, comet: null, ctoken: null, aTokenProof: false, isDebtToken: false, vaultProof: false, cometProof: false };
const WBERA = "0x6969696969696969696969696969696969696969";

test("a token answering only baseToken() is not a Compound v3 market (Bera the Cub)", () => {
  assert.equal(provenReceipt({ ...none, comet: WBERA }), null);
  assert.deepEqual(provenReceipt({ ...none, comet: WBERA, cometProof: true }), { kind: "comet", asset: WBERA });
});

test("a vault needs totalAssets(); an aToken needs its treasury; a debt token never counts", () => {
  assert.equal(provenReceipt({ ...none, erc4626: "0xA" }), null);
  assert.deepEqual(provenReceipt({ ...none, erc4626: "0xA", vaultProof: true }), { kind: "erc4626", asset: "0xA" });
  assert.equal(provenReceipt({ ...none, aave: "0xB" }), null);
  assert.equal(provenReceipt({ ...none, aave: "0xB", aTokenProof: true, isDebtToken: true }), null);
  assert.deepEqual(provenReceipt({ ...none, aave: "0xB", aTokenProof: true }), { kind: "aave", asset: "0xB" });
});

test("a claim can't exceed the underlying's supply, or a vault's own assets", () => {
  const e18 = BigInt(10) ** BigInt(18);
  assert.equal(claimBelievable(BigInt(1_010_069) * e18, { underlyingSupply: BigInt(81_803_084) * e18 }, "comet"), true);
  assert.equal(claimBelievable(BigInt(100) * e18, { underlyingSupply: BigInt(10) * e18 }, "aave"), false);
  assert.equal(claimBelievable(BigInt(5), { underlyingSupply: BigInt(1000), vaultTotalAssets: BigInt(4) }, "erc4626"), false);
  assert.equal(claimBelievable(BigInt(5), { underlyingSupply: BigInt(1000), vaultTotalAssets: BigInt(50) }, "erc4626"), true);
});

test("an unreadable bound rejects the claim", () => {
  assert.equal(claimBelievable(BigInt(1), { underlyingSupply: null }, "ctoken"), false);
  assert.equal(claimBelievable(BigInt(1), { underlyingSupply: BigInt(10), vaultTotalAssets: null }, "erc4626"), false);
});

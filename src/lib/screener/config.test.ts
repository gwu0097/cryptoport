import test from "node:test";
import assert from "node:assert/strict";
import { SCREENER_CONFIG, validateConfig, configHash, canonicalJson, sectorBucketFor, type CandidateFactor } from "./config.ts";

const factor = (over: Partial<CandidateFactor>): CandidateFactor => ({
  factor: "ps", weight: 0, status: "candidate", evidence_ref: null, changed_at: "2026-09-22", note: "", ...over,
});

test("the shipped config is valid", () => {
  assert.doesNotThrow(() => validateConfig(SCREENER_CONFIG));
});

test("a factor can't go active without an evidence_ref", () => {
  assert.throws(() => validateConfig({ candidateFactors: [factor({ status: "active", weight: 0.5 })] }), /evidence_ref/);
  assert.doesNotThrow(() => validateConfig({ candidateFactors: [factor({ status: "active", weight: 0.5, evidence_ref: "backtest-1" })] }));
});

test("only active factors may carry weight", () => {
  assert.throws(() => validateConfig({ candidateFactors: [factor({ weight: 0.2 })] }), /only active factors carry weight/);
});

test("config hash ignores key order but changes with any value", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  const changed = { ...SCREENER_CONFIG, gates: { ...SCREENER_CONFIG.gates, minRevenueAnnualizedUsd: 5_000_000 } };
  assert.notEqual(configHash(changed), configHash(SCREENER_CONFIG));
  assert.equal(configHash(SCREENER_CONFIG), configHash(SCREENER_CONFIG));
});

test("revenue floor is $1M (decided 2026-09-22), regime marked unvalidated", () => {
  assert.equal(SCREENER_CONFIG.gates.minRevenueAnnualizedUsd, 1_000_000);
  assert.equal(SCREENER_CONFIG.regime.validated, false);
});

test("sector buckets: known categories map, unknown is other, L1s are out of scope", () => {
  assert.equal(sectorBucketFor("Derivatives"), "perps_dex");
  assert.equal(sectorBucketFor("Liquid Staking"), "liquid_staking");
  assert.equal(sectorBucketFor("Chain"), "out_of_scope");
  assert.equal(sectorBucketFor("Physical TCG"), "other");
  assert.equal(sectorBucketFor(null), "other");
});

test("every holder mechanism cites at least one source and a real as_of date", () => {
  for (const [id, m] of Object.entries(SCREENER_CONFIG.holderValueMechanisms)) {
    assert.ok(m.sourceUrls.length > 0 && m.sourceUrls.every((u) => u.startsWith("https://")), id);
    assert.match(m.as_of, /^\d{4}-\d{2}-\d{2}$/, id);
  }
});

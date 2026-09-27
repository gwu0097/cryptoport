import test from "node:test";
import assert from "node:assert/strict";
import { isIlliquid } from "./liquidity.ts";

// Real cases from docs/pricing/ILLIQUID.md (2026-09-26).
test("airdropped junk is illiquid", () => {
  assert.equal(isIlliquid(339_500, { volume24h: 710, marketCap: 0 }), true); // WHITE, no market cap
  assert.equal(isIlliquid(102_126, { volume24h: 42, marketCap: 1_579_170 }), true); // KNCL, 6.5% of mcap
  assert.equal(isIlliquid(124_810, { volume24h: 106_196, marketCap: 1_751_097 }), true); // MOODENG, 7%
});

test("real positions are not", () => {
  assert.equal(isIlliquid(4_812_415, { volume24h: 9_481_234, marketCap: 415_473_344 }), false); // SPX whale
  assert.equal(isIlliquid(133_368, { volume24h: 129_366, marketCap: 6_665_524 }), false); // 2% of mcap
  assert.equal(isIlliquid(2_769, { volume24h: 0, marketCap: 6_179_576_003 }), false); // an Aave receipt
});

test("no volume data, or a small holding, is never flagged", () => {
  assert.equal(isIlliquid(1_000_000, { volume24h: null, marketCap: null }), false);
  assert.equal(isIlliquid(1_000_000, undefined), false);
  assert.equal(isIlliquid(900, { volume24h: 1, marketCap: 0 }), false);
});

test("no market cap: thin but redeemable stays counted; junk hundreds of times its volume doesn't", () => {
  assert.equal(isIlliquid(2_320, { volume24h: 2_019, marketCap: 0 }), false); // Lido stMATIC, 1.15×
  assert.equal(isIlliquid(339_500, { volume24h: 710, marketCap: null }), true); // WHITE, 478×
});

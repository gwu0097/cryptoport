import test from "node:test";
import assert from "node:assert/strict";
import { displaySymbol, tokenAmount } from "./unrecognizedTokens.ts";

test("raw balances become whole tokens; unknown decimals stay unknown", () => {
  assert.equal(tokenAmount("100000000000000000", 18), 0.1);
  assert.equal(tokenAmount("1234500", 6), 1.2345);
  assert.equal(tokenAmount("5", 0), 5);
  assert.equal(tokenAmount("100000000000000000", null), null);
  assert.equal(tokenAmount(null, 18), null);
  assert.equal(tokenAmount("-1", 18), null);
});

test("a huge spam supply keeps its whole part", () => {
  assert.equal(tokenAmount("1000000000000000000000000000000", 18), 1e12);
});

test("symbols are plain text: control and zero-width characters removed, long ones cut", () => {
  assert.equal(displaySymbol("US\u200bDC"), "USDC");
  assert.equal(displaySymbol("  a \n b  "), "a b");
  assert.equal(displaySymbol(""), "?");
  assert.equal(displaySymbol(null), "?");
  assert.equal(displaySymbol("Visit claim-rewards-now.com to get yours").length, 24);
});

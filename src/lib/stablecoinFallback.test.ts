import test from "node:test";
import assert from "node:assert/strict";
import { stablecoinFallbackUsd } from "./stablecoinFallback.ts";

test("only listed stablecoins get a $1 fallback", () => {
  assert.equal(stablecoinFallbackUsd("USDC", 25), 25);
  assert.equal(stablecoinFallbackUsd("usde", 3), 3);
  assert.equal(stablecoinFallbackUsd("PUSD", 7), 7);
});

test("anything else — memes, other tokens, lookalike tickers — gets none", () => {
  for (const t of ["PURR", "HYPE", "WOW", "USDC.E", "USDX", "DAI", "USD"]) assert.equal(stablecoinFallbackUsd(t, 1000), null, t);
});

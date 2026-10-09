import { test } from "node:test";
import assert from "node:assert/strict";
import { earnHoldings } from "./jupiterEarn.ts";

const sol = {
  token: { address: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU", symbol: "jlWSOL", decimals: 9, assetAddress: "So11111111111111111111111111111111111111112", asset: { address: "So11111111111111111111111111111111111111112", symbol: "WSOL", uiSymbol: "SOL", decimals: 9, logoUrl: "https://x/sol.png" } },
  shares: "11949922666",
  underlyingAssets: "12507985361",
};

test("a deposit is the asset it holds, in its own units (Solana Seeker 1's 12.508 SOL, 2026-10-09)", () => {
  const { holdings, warnings } = earnHoldings([sol]);
  assert.deepEqual(warnings, []);
  assert.equal(holdings.length, 1);
  const h = holdings[0];
  assert.deepEqual(
    { t: h.ticker, q: h.qty, c: h.contract, chain: h.chain, cat: h.category, p: h.protocol, icon: h.icon_url },
    { t: "SOL", q: 12.507985361, c: "So11111111111111111111111111111111111111112", chain: "solana-defi", cat: "defi", p: "Jupiter Earn", icon: "https://x/sol.png" },
  );
  assert.equal(h.protocol_url, "https://jup.ag/lend/earn?symbol=SOL&action=deposit");
});

test("empty positions are skipped; one that can't be read is named, not guessed", () => {
  const usdc = { token: { symbol: "jlUSDC", asset: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", uiSymbol: "USDC", decimals: 6 } }, underlyingAssets: "2500000" };
  const { holdings, warnings } = earnHoldings([{ ...sol, underlyingAssets: "0" }, usdc, { token: { symbol: "jlX" }, underlyingAssets: "5" }]);
  assert.deepEqual(holdings.map((h) => [h.ticker, h.qty]), [["USDC", 2.5]]);
  assert.deepEqual(warnings, ["Jupiter Earn: a position in jlX couldn't be read"]);
});

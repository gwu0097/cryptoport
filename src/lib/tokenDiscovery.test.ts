import test from "node:test";
import assert from "node:assert/strict";
import { candidateTokens, classifyHeld, type HeldToken, type TokenInfo } from "./tokenDiscovery.ts";

const CELO_ERC20 = "0x471ece3750da237f93b8e339c536989b8978a438";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const SPAM = "0x1111111111111111111111111111111111111111";
const registry = [
  { contract: CELO_ERC20, symbol: "CELO", decimals: 18, coingecko_id: "celo", image_url: null },
  { contract: USDC.toUpperCase().replace("0X", "0x"), symbol: "USDC", decimals: 6, coingecko_id: "usd-coin", image_url: null },
];

test("discovered ∪ previous, read once, native coin's ERC-20 dropped, unlisted marked", () => {
  const out = candidateTokens({ discovered: [USDC, SPAM, CELO_ERC20, "not-an-address"], previous: [USDC.toUpperCase().replace("0X", "0x")], registry, includeWholeRegistry: false, nativeCoingeckoId: "celo" });
  assert.deepEqual(out.map((t) => [t.contract, t.listed]), [[USDC, true], [SPAM, false]]);
});

test("when discovery didn't complete, every listed token is read too", () => {
  const out = candidateTokens({ discovered: [], previous: [], registry, includeWholeRegistry: true, nativeCoingeckoId: "ethereum" });
  assert.deepEqual(out.map((t) => t.contract).sort(), [CELO_ERC20, USDC].sort());
});

const token = (over: Partial<TokenInfo>): TokenInfo => ({ contract: SPAM, symbol: "X", decimals: 18, coingecko_id: null, image_url: null, listed: false, ...over });
const held = (t: TokenInfo, qty: number | null): HeldToken => ({ token: t, qty, raw: BigInt(1) });
const prices = new Map([["usd-coin", 1], ["weth", 3000]]);

test("priced tokens are counted; sub-floor ones are dust", () => {
  assert.equal(classifyHeld(held(token({ coingecko_id: "usd-coin", listed: true }), 5), prices, undefined, 0.01).kind, "counted");
  assert.equal(classifyHeld(held(token({ coingecko_id: "usd-coin", listed: true }), 0.001), prices, undefined, 0.01).kind, "dust");
});

test("an unlisted receipt is valued as its underlying (aTkoWETH as WETH)", () => {
  const c = classifyHeld(held(token({ symbol: "aTkoWETH" }), 0.005), prices, { underlyingId: "weth", underlyingSymbol: "WETH", underlyingQty: 0.005 }, 0.01);
  assert.equal(c.kind, "receipt");
});

test("everything else is unrecognized, with why — never dropped", () => {
  assert.deepEqual(classifyHeld(held(token({}), 1e6), prices, undefined, 0.01), { kind: "unrecognized", held: held(token({}), 1e6), reason: "unlisted" });
  const listedNoPrice = classifyHeld(held(token({ coingecko_id: "dead-coin", listed: true }), 10), prices, undefined, 0.01);
  assert.equal(listedNoPrice.kind === "unrecognized" && listedNoPrice.reason, "unpriced");
  const receiptNoPrice = classifyHeld(held(token({}), 1), prices, { underlyingId: "unknown", underlyingSymbol: "?", underlyingQty: 1 }, 0.01);
  assert.equal(receiptNoPrice.kind, "unrecognized");
  assert.equal(classifyHeld(held(token({ coingecko_id: "usd-coin", listed: true }), null), prices, undefined, 0.01).kind, "unrecognized"); // no decimals: can't size it
});

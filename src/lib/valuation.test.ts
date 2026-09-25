import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  parseNumeric,
  valueHolding,
  type HoldingValuationInput,
} from "./valuation.ts";

function holding(overrides: Partial<HoldingValuationInput>): HoldingValuationInput {
  return {
    ticker: "BTC",
    qty: null,
    usd_override: null,
    source: "manual_qty",
    ...overrides,
  };
}

test("manual_usd ignores an available price", () => {
  const h = holding({ source: "manual_usd", usd_override: "500", qty: null });
  const result = valueHolding(h, { BTC: "999999" });
  assert.deepEqual(result, { kind: "priced", usd: 500 });
});

test("manual_usd with null qty is valid", () => {
  const h = holding({ source: "manual_usd", usd_override: "42", qty: null });
  const result = valueHolding(h, {});
  assert.deepEqual(result, { kind: "priced", usd: 42 });
});

test("manual_usd with no usd_override is unpriced, not zero", () => {
  const h = holding({ source: "manual_usd", usd_override: null });
  const result = valueHolding(h, { BTC: "100" });
  assert.deepEqual(result, { kind: "unpriced", reason: "no_usd_override" });
});

test("manual_qty with a price multiplies qty * price", () => {
  const h = holding({ source: "manual_qty", qty: "1.5291763", ticker: "BTC", price_key: "bitcoin" });
  const result = valueHolding(h, { bitcoin: "60000" });
  assert.equal(result.kind, "priced");
  assert.ok(result.kind === "priced" && Math.abs(result.usd - 91750.578) < 1e-6);
});

test("manual_qty with no price is unpriced, not qty, not zero", () => {
  const h = holding({ source: "manual_qty", qty: "10", ticker: "SHIB" });
  const result = valueHolding(h, {});
  assert.deepEqual(result, { kind: "unpriced", reason: "no_price" });
});

test("auto with no price is unpriced", () => {
  const h = holding({ source: "auto", qty: "334840581", ticker: "SPAM" });
  const result = valueHolding(h, { SPAM: undefined });
  assert.deepEqual(result, { kind: "unpriced", reason: "no_price" });
});

test("auto with no qty is unpriced even if a price exists", () => {
  const h = holding({ source: "auto", qty: null, ticker: "ETH" });
  const result = valueHolding(h, { ETH: "3000" });
  assert.deepEqual(result, { kind: "unpriced", reason: "no_qty" });
});

// The Hyperliquid adapter pins stablecoins (USDC/USDT0/USDE) at $1 this way
// instead of routing them through the ticker-price pipeline.
test("auto with a usd_override is priced directly, ignoring qty*price", () => {
  const h = holding({ source: "auto", qty: "10769.26", usd_override: "10769.26", ticker: "USDT0" });
  const result = valueHolding(h, {}); // no price for USDT0 in the map at all
  assert.deepEqual(result, { kind: "priced", usd: 10769.26 });
});

test("parseNumeric handles PostgREST numeric strings", () => {
  assert.equal(parseNumeric("1.5291763"), 1.5291763);
  assert.equal(parseNumeric("334840581"), 334840581);
  assert.equal(parseNumeric("0.000003586983096"), 0.000003586983096);
});

// Verified empirically against this project's Supabase setup: PostgREST/
// supabase-js hands numeric columns back as JS numbers, not strings. The
// string path above is kept because that representation is documented
// PostgREST behavior elsewhere and could return with a version change.
test("parseNumeric handles PostgREST numeric values already deserialized as numbers", () => {
  assert.equal(parseNumeric(1.5291763), 1.5291763);
  assert.equal(parseNumeric(334840581), 334840581);
  assert.equal(parseNumeric(0), 0);
});

test("parseNumeric rejects null, undefined, and garbage", () => {
  assert.equal(parseNumeric(null), null);
  assert.equal(parseNumeric(undefined), null);
  assert.equal(parseNumeric("not-a-number"), null);
  assert.equal(parseNumeric(""), null);
  assert.equal(parseNumeric(Infinity), null);
  assert.equal(parseNumeric(NaN), null);
});

test("aggregate totals priced holdings and reports unpriced count/tickers", () => {
  const holdings: HoldingValuationInput[] = [
    holding({ source: "manual_qty", ticker: "BTC", qty: "1.5291763", price_key: "bitcoin" }),
    holding({ source: "auto", ticker: "ETH", qty: "2", price_key: "ethereum" }),
    holding({ source: "manual_usd", ticker: "USDC", usd_override: "1000" }),
    holding({ source: "auto", ticker: "SPAM", qty: "999999" }), // no price
    holding({ source: "manual_qty", ticker: "DUST", qty: null }), // no qty
  ];

  const prices = { bitcoin: "60000", ethereum: "3000" };
  const result = aggregate(holdings, prices);

  const expectedTotal = 1.5291763 * 60000 + 2 * 3000 + 1000;
  assert.ok(Math.abs(result.total - expectedTotal) < 1e-6);
  assert.equal(result.unpricedCount, 2);
  assert.deepEqual(new Set(result.unpricedTickers), new Set(["SPAM", "DUST"]));
});

test("valueHolding works when qty/price arrive as numbers, not strings", () => {
  const h = holding({ source: "manual_qty", qty: 1.5291763, ticker: "BTC", price_key: "bitcoin" });
  const result = valueHolding(h, { bitcoin: 60000 });
  assert.equal(result.kind, "priced");
  assert.ok(result.kind === "priced" && Math.abs(result.usd - 91750.578) < 1e-6);
});

test("aggregate never coerces unpriced holdings into the total", () => {
  const holdings: HoldingValuationInput[] = [
    holding({ source: "auto", ticker: "SPAM", qty: "334840581" }),
  ];
  const result = aggregate(holdings, {});
  assert.equal(result.total, 0);
  assert.equal(result.unpricedCount, 1);
  assert.deepEqual(result.unpricedTickers, ["SPAM"]);
});

test("one asset, one price: never priced by ticker (a ticker can name several coins)", () => {
  const h = holding({ source: "auto", qty: "10", ticker: "ORCA" }); // no price_key
  assert.deepEqual(valueHolding(h, { ORCA: "3" }), { kind: "unpriced", reason: "no_price" });
});

test("the asset's one price wins over a stale sync-time value; the stored value stands only while the asset has no price", () => {
  const h = holding({ source: "auto", qty: "100", ticker: "HASUI", price_key: "haedal-staked-sui", usd_override: "108.4" });
  assert.deepEqual(valueHolding(h, { "haedal-staked-sui": "1.2" }), { kind: "priced", usd: 120 });
  assert.deepEqual(valueHolding(h, {}), { kind: "priced", usd: 108.4 });
});

test("a protocol position (no price_key) keeps its stored value; a fixed-USD holding ignores any key", () => {
  assert.deepEqual(valueHolding(holding({ source: "auto", qty: "1", ticker: "METEORA-LP", usd_override: "27.5" }), {}), { kind: "priced", usd: 27.5 });
  assert.deepEqual(valueHolding(holding({ source: "manual_usd", ticker: "BTC", usd_override: "500", price_key: "bitcoin" }), { bitcoin: "60000" }), { kind: "priced", usd: 500 });
});

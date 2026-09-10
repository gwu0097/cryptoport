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
  const h = holding({ source: "manual_qty", qty: "1.5291763", ticker: "BTC" });
  const result = valueHolding(h, { BTC: "60000" });
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
    holding({ source: "manual_qty", ticker: "BTC", qty: "1.5291763" }),
    holding({ source: "auto", ticker: "ETH", qty: "2" }),
    holding({ source: "manual_usd", ticker: "USDC", usd_override: "1000" }),
    holding({ source: "auto", ticker: "SPAM", qty: "999999" }), // no price
    holding({ source: "manual_qty", ticker: "DUST", qty: null }), // no qty
  ];

  const prices = { BTC: "60000", ETH: "3000" };
  const result = aggregate(holdings, prices);

  const expectedTotal = 1.5291763 * 60000 + 2 * 3000 + 1000;
  assert.ok(Math.abs(result.total - expectedTotal) < 1e-6);
  assert.equal(result.unpricedCount, 2);
  assert.deepEqual(new Set(result.unpricedTickers), new Set(["SPAM", "DUST"]));
});

test("valueHolding works when qty/price arrive as numbers, not strings", () => {
  const h = holding({ source: "manual_qty", qty: 1.5291763, ticker: "BTC" });
  const result = valueHolding(h, { BTC: 60000 });
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

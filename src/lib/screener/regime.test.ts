import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRegime, percentileOf, oneValuePerDay, type RegimeInputs } from "./regime.ts";

const none: RegimeInputs = {
  btcDominancePct: null, btcDominance4wChangePts: null, ethBtc4wChangePct: null,
  stablecoinSupply30dChangePct: null, fundingPercentile: null, btcOi4wChangePct: null, btcPrice4wChangePct: null,
};
const fired = (r: ReturnType<typeof evaluateRegime>, rule: string) => r.rules.find((x) => x.rule === rule)?.fired;

test("no inputs: every rule is not evaluable and the label is NEUTRAL", () => {
  const r = evaluateRegime(none);
  assert.equal(r.label, "NEUTRAL");
  assert.ok(r.rules.every((x) => x.fired === null));
});

test("day-one state (no stored dominance history): BTC_LED can't fire even at high dominance", () => {
  const r = evaluateRegime({ ...none, btcDominancePct: 58.7, stablecoinSupply30dChangePct: 0.17, ethBtc4wChangePct: 2 });
  assert.equal(fired(r, "BTC_LED"), null);
  assert.equal(r.label, "NEUTRAL");
});

test("an AND rule is definitely false as soon as one known input fails, even with others unknown", () => {
  const r = evaluateRegime({ ...none, stablecoinSupply30dChangePct: 3 });
  assert.equal(fired(r, "RISK_OFF"), false);
});

test("BTC_LED with full history", () => {
  const r = evaluateRegime({ ...none, btcDominancePct: 59, btcDominance4wChangePts: 0.2, stablecoinSupply30dChangePct: 0.4 });
  assert.equal(r.label, "BTC_LED");
});

test("ROTATION: dominance falling hard while ETH/BTC rises", () => {
  const r = evaluateRegime({ ...none, btcDominancePct: 55, btcDominance4wChangePts: -2, ethBtc4wChangePct: 4, stablecoinSupply30dChangePct: 2 });
  assert.equal(r.label, "ROTATION");
});

test("FROTH fires on either clause, and outranks everything else", () => {
  const base = { ...none, btcDominancePct: 59, btcDominance4wChangePts: 0.2, stablecoinSupply30dChangePct: 0.4 };
  assert.equal(evaluateRegime({ ...base, fundingPercentile: 0.95 }).label, "FROTH");
  assert.equal(evaluateRegime({ ...base, btcOi4wChangePct: 40, btcPrice4wChangePct: 10 }).label, "FROTH");
  assert.equal(evaluateRegime({ ...base, fundingPercentile: 0.5, btcOi4wChangePct: 12, btcPrice4wChangePct: 10 }).label, "BTC_LED");
});

test("RISK_OFF: shrinking stablecoins and rising dominance", () => {
  assert.equal(evaluateRegime({ ...none, stablecoinSupply30dChangePct: -1, btcDominance4wChangePts: 1 }).label, "RISK_OFF");
});

test("percentile needs enough history, and never counts ties as below", () => {
  assert.equal(percentileOf(5, [1, 2, 3], 30), null);
  const hist = Array.from({ length: 40 }, (_, i) => i);
  assert.equal(percentileOf(20, hist, 30), 0.5);
  assert.equal(percentileOf(null, hist, 30), null);
});

test("funding history counts days, not runs: same-day rows collapse to the latest", () => {
  const rows = [
    { computed_at: "2026-09-22T23:05:00Z", value: 1 },
    { computed_at: "2026-09-22T21:00:00Z", value: 9 },
    { computed_at: "2026-09-23T07:00:00Z", value: 2 },
    { computed_at: "2026-09-24T07:00:00Z", value: null },
  ];
  assert.deepEqual(oneValuePerDay(rows), [1, 2]);
});

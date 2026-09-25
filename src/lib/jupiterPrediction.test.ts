import test from "node:test";
import assert from "node:assert/strict";
import { predictionRows, type JupiterPredictionApiPosition } from "./jupiterPrediction.ts";

// Shaped like a live position from api.jup.ag/prediction/v1/positions (2026-09-25).
const OPEN: JupiterPredictionApiPosition = {
  pubkey: "pos1",
  isYes: true,
  contractsDecimal: "20.08",
  valueUsd: "8835200",
  payoutUsd: "20080000",
  pnlUsd: "-401600",
  pnlUsdPercent: -4.34,
  claimable: false,
  claimed: false,
  eventMetadata: { title: "Chengdu Open: Martin Damm vs Hubert Hurkacz" },
  marketMetadata: { title: "Hubert Hurkacz", result: null },
};

test("an open position is worth its mark-to-market value, labeled with event, market and side", () => {
  const [r] = predictionRows([OPEN]);
  assert.equal(r.valueUsd, 8.8352);
  assert.equal(r.contracts, 20.08);
  assert.equal(r.pnlUsd, -0.4016);
  assert.equal(r.pnlPercent, -4.34);
  assert.equal(r.label, "Chengdu Open: Martin Damm vs Hubert Hurkacz — Hubert Hurkacz (YES)");
});

test("a won position waiting to be claimed is worth its payout", () => {
  const [r] = predictionRows([{ ...OPEN, valueUsd: null, claimable: true, marketMetadata: { title: "Hubert Hurkacz", result: "yes" } }]);
  assert.equal(r.valueUsd, 20.08);
});

test("claimed or lost positions leave no row", () => {
  assert.deepEqual(predictionRows([{ ...OPEN, claimed: true }]), []);
  assert.deepEqual(predictionRows([{ ...OPEN, valueUsd: null, claimable: false, marketMetadata: { title: "x", result: "no" } }]), []);
});

test("closed but unresolved is unknown, never 0", () => {
  const [r] = predictionRows([{ ...OPEN, valueUsd: null, claimable: false, marketMetadata: { title: "x", result: null } }]);
  assert.equal(r.valueUsd, null);
});

test("a market titled like its event isn't repeated", () => {
  const [r] = predictionRows([{ ...OPEN, isYes: false, eventMetadata: { title: "Clarity Act signed?" }, marketMetadata: { title: "Clarity Act signed?" } }]);
  assert.equal(r.label, "Clarity Act signed? (NO)");
});

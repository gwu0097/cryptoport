import test from "node:test";
import assert from "node:assert/strict";
import { summarizePositions } from "./positionsSummary.ts";

test("PnL sums only the known ones; margin is perps, predictions their value", () => {
  const s = summarizePositions([
    { kind: "perp", pnlUsd: 100, valueUsd: 2_000 },
    { kind: "perp", pnlUsd: null, valueUsd: 1_000 },
    { kind: "prediction", pnlUsd: -5, valueUsd: 75 },
  ]);
  assert.deepEqual(s, { count: 3, pnlUsd: 95, unknownPnl: 1, perps: 2, marginUsd: 3_000, predictions: 1, predictionUsd: 75 });
});

test("no PnL known is unknown, never 0", () => {
  assert.equal(summarizePositions([{ kind: "perp", pnlUsd: null, valueUsd: 10 }]).pnlUsd, null);
  assert.equal(summarizePositions([]).pnlUsd, null);
});

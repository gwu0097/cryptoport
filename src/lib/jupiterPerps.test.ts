import test from "node:test";
import assert from "node:assert/strict";
import { perpsRows, type JupiterPerpsApiPosition } from "./jupiterPerps.ts";

// A live SOL short from perps-api.jup.ag/v2/positions (2026-09-25), matched
// field by field against its on-chain Position account.
const SOL_SHORT: JupiterPerpsApiPosition = {
  asset: "SOL",
  assetMint: "So11111111111111111111111111111111111111112",
  side: "short",
  leverage: "68.83",
  sizeUsd: "16014470889",
  sizeTokenAmount: "131164345493",
  valueUsd: "206740081",
  entryPriceUsd: "122094696",
  liquidationPriceUsd: "123538693",
  pnlAfterFeesUsd: "-25900230",
  pnlAfterFeesPct: "-11.13",
};

test("a position is worth what closing it returns (valueUsd), in dollars", () => {
  const { rows, unreadable } = perpsRows([SOL_SHORT]);
  assert.equal(unreadable, 0);
  const [r] = rows;
  assert.equal(r.ticker, "SOL-PERP");
  assert.equal(r.valueUsd, 206.740081);
  assert.equal(r.side, "short");
  assert.equal(r.leverage, 68.83);
  assert.equal(r.entryPrice, 122.094696);
  assert.equal(r.liquidationPrice, 123.538693);
  assert.equal(r.pnlUsd, -25.90023);
  assert.equal(r.pnlPercent, -11.13);
  assert.equal(r.tpsl, null); // no tpslRequests field: not known
  assert.ok(Math.abs(r.qty! - 131.164345493) < 1e-3); // sizeUsd / entry ≈ sizeTokenAmount at 9 decimals
});

test("a market Jupiter adds later needs no code change", () => {
  const { rows } = perpsRows([{ ...SOL_SHORT, asset: "JUP", side: "long" }]);
  assert.equal(rows[0].ticker, "JUP-PERP");
  assert.equal(rows[0].side, "long");
});

test("a position that can't be read is counted, never guessed", () => {
  const { rows, unreadable } = perpsRows([{ ...SOL_SHORT, valueUsd: "" }, { ...SOL_SHORT, side: "flat" }, SOL_SHORT]);
  assert.equal(rows.length, 1);
  assert.equal(unreadable, 2);
});

test("no open positions: nothing, and nothing unreadable", () => {
  assert.deepEqual(perpsRows([]), { rows: [], unreadable: 0 });
});

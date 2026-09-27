import test from "node:test";
import assert from "node:assert/strict";
import { positionChanges } from "./watchPositions.ts";
import type { AssetState, Movement } from "./watchDiff.ts";

const state = (key: string, qty: number, kept = false): AssetState => ({ key, type: "token", ticker: key.toUpperCase(), label: null, priceKey: key, side: null, qty, kept });
const priceOf = () => 10;
const move = (assetKey: string, kind: Movement["kind"], qtyAfter: number): Movement => ({ assetKey, kind, positionType: "token", ticker: assetKey, label: null, priceKey: assetKey, side: null, qtyBefore: 0, qtyAfter, priceUsd: 10, usdDelta: 0 });

test("the first read records what's held as held-at-start, skipping small ones", () => {
  const c = positionChanges({ firstRead: true, states: new Map([["eth", state("eth", 50)], ["dust", state("dust", 1)]]), movements: [], open: [], now: "T1", priceOf });
  assert.deepEqual(c.inserts.map((i) => [i.assetKey, i.heldAtStart, i.entryPrice]), [["eth", true, 10]]);
});

test("new opens, exited closes, a change or no change keeps it current", () => {
  const c = positionChanges({
    firstRead: false,
    states: new Map([["wif", state("wif", 30)], ["eth", state("eth", 50)], ["sol", state("sol", 5, true)]]),
    movements: [move("wif", "new", 30), move("pepe", "exited", 0), move("eth", "added", 50)],
    open: [{ assetKey: "pepe", openedAt: "T0" }, { assetKey: "eth", openedAt: "T0" }, { assetKey: "sol", openedAt: "T0" }],
    now: "T2",
    priceOf,
  });
  assert.deepEqual(c.inserts.map((i) => [i.assetKey, i.heldAtStart]), [["wif", false]]);
  assert.deepEqual(c.closes, [{ assetKey: "pepe", openedAt: "T0", exitPrice: 10 }]);
  assert.deepEqual(c.touches, [{ assetKey: "eth", openedAt: "T0", qty: 50 }]); // sol was kept: not refreshed
});

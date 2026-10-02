import test from "node:test";
import assert from "node:assert/strict";
import { changeSinceClose, mergeByTicker } from "./attribution.ts";

test("the same token on several chains is one row, its change combined", () => {
  const rows = mergeByTicker([
    { key: "wrapped-eeth", ticker: "weETH", valueUsd: 10_060, changePct: 0.6, usd: 60 },
    { key: "bridged-weeth", ticker: "WEETH", valueUsd: 5_030, changePct: 0.6, usd: 30 },
    { key: "weth", ticker: "WETH", valueUsd: 1_000, changePct: 0.5, usd: 5 },
  ]);
  assert.deepEqual(rows.map((r) => [r.ticker, Math.round(r.usd)]), [["weETH", 90], ["WETH", 5]]);
  assert.ok(Math.abs(rows[0].changePct - (90 / 15_000) * 100) < 1e-9);
});

test("a window's change runs from the coin's own close on the snapshot day, when there is one", () => {
  const closes = new Map([["2026-09-25", 100]]);
  assert.ok(Math.abs(changeSinceClose(closes, "2026-09-25", 105)! - 5) < 1e-9);
  assert.equal(changeSinceClose(closes, "2026-09-24", 105), null); // no close that day: the source's 7d change instead
  assert.equal(changeSinceClose(undefined, "2026-09-25", 105), null);
  assert.equal(changeSinceClose(closes, "2026-09-25", null), null);
});

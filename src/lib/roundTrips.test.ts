import test from "node:test";
import assert from "node:assert/strict";
import { dbSpanMs, serialDepth } from "./roundTrips.ts";

test("requests started together are one round trip", () => {
  assert.equal(serialDepth([{ start: 0, end: 100 }, { start: 1, end: 200 }, { start: 2, end: 150 }]), 1);
});

test("the dashboard's measured waterfall: 7 serial round trips", () => {
  // start + duration, as logged on 2026-09-29 (asset_prices 3 pages, then assets 2, then the watch feed 2).
  const log = [
    [1, 99], [11, 98], [11, 105], [12, 109], [10, 170], [11, 207], [12, 206],
    [245, 243], [503, 111], [620, 145], [808, 182],
    [1018, 118], [1017, 125], [1017, 129], [1018, 131], [1018, 424],
    [1451, 126], [1450, 133],
  ].map(([s, d]) => ({ start: s, end: s + d }));
  assert.equal(serialDepth(log), 7);
  assert.equal(dbSpanMs(log), 1582);
});

test("nothing measured: zero", () => {
  assert.equal(serialDepth([]), 0);
  assert.equal(dbSpanMs([]), 0);
});

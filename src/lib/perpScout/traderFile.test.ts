import test from "node:test";
import assert from "node:assert/strict";
import { parseTraderImport, tradersToCsv } from "./traderFile.ts";
import type { FollowedTrader } from "./followed.ts";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const trader = (address: string, name: string, why = "picked"): FollowedTrader =>
  ({ address, name, addedOn: "2026-10-06", why, picked: { asOf: "2026-10-06", equity: 1, allTimePnl: 1, monthPnl: 1, historyMonths: 1, winningWeeks: 0.5, drawdownShare: 0.1, bestFourShare: 0.2 } }) as FollowedTrader;

test("an export reads back as the same addresses and names", () => {
  const csv = tradersToCsv([trader(A, 'Swing "fast", 2d'), trader(B, "Calm", "line, with comma")]);
  assert.match(csv, /^address,name,added_on,why\n/);
  assert.deepEqual(parseTraderImport(csv), { traders: [{ address: A, name: 'Swing "fast", 2d' }, { address: B, name: "Calm" }], skipped: 0 });
});

test("plain lines: an address, an optional name; junk counted, duplicates once", () => {
  const text = `${A.toUpperCase().replace("0X", "0x")}\tFirst\n\nnot an address\n${B}, Second\n${A}, again`;
  assert.deepEqual(parseTraderImport(text), { traders: [{ address: A, name: "First" }, { address: B, name: "Second" }], skipped: 1 });
});

test("JSON: an array of traders, of addresses, or { traders }", () => {
  assert.deepEqual(parseTraderImport(JSON.stringify([trader(A, "One")])).traders, [{ address: A, name: "One" }]);
  assert.deepEqual(parseTraderImport(JSON.stringify([B, "nope"])), { traders: [{ address: B, name: null }], skipped: 1 });
  assert.deepEqual(parseTraderImport(JSON.stringify({ traders: [{ address: A }] })).traders, [{ address: A, name: null }]);
  assert.deepEqual(parseTraderImport("{broken"), { traders: [], skipped: 1 });
});

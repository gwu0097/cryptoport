import test from "node:test";
import assert from "node:assert/strict";
import { FOLLOWED } from "./followed.ts";

test("every followed trader is a lowercase Hyperliquid address, listed once", () => {
  for (const f of FOLLOWED) assert.match(f.address, /^0x[0-9a-f]{40}$/, f.name);
  assert.equal(new Set(FOLLOWED.map((f) => f.address)).size, FOLLOWED.length);
  for (const f of FOLLOWED) assert.match(f.addedOn, /^\d{4}-\d{2}-\d{2}$/);
});

test("mergeFollowed: the code list first, page additions after, no repeats", async () => {
  const { mergeFollowed, isTraderAddress } = await import("./followed.ts");
  const t = (address: string, name: string) => ({ address, name, addedOn: "2026-10-06", why: "", picked: { asOf: "2026-10-06", equity: null, allTimePnl: null, monthPnl: null, historyMonths: null, winningWeeks: null, drawdownShare: null, bestFourShare: null } });
  const merged = mergeFollowed([t("0xa", "code")], [t("0xa", "dup"), t("0xb", "page")]);
  assert.deepEqual(merged.map((f) => f.name), ["code", "page"]);
  assert.deepEqual(mergeFollowed([t("0xa", "code")], [t("0xb", "page")], ["0xa"]).map((f) => f.name), ["page"], "a code trader removed on the page");
  assert.equal(isTraderAddress("0x" + "a".repeat(40)), true);
  assert.equal(isTraderAddress("0x" + "A".repeat(40)), false, "lowercase only (callers lowercase first)");
  assert.equal(isTraderAddress("0x123"), false);
});

test("mergeFollowed: a name given on the page replaces the list's", async () => {
  const { mergeFollowed } = await import("./followed.ts");
  const t = (address: string, name: string) => ({ address, name }) as never;
  assert.deepEqual(mergeFollowed([t("0xa", "code")], [t("0xb", "page")], [], { "0xa": "Renamed" }).map((f: { name: string }) => f.name), ["Renamed", "page"]);
});

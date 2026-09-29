import test from "node:test";
import assert from "node:assert/strict";
import { backfillMovements, readTimes } from "./watchBackfill.ts";
import type { ActivityLeg } from "./watchActivity.ts";

const leg = (assetKey: string, qtyDelta: number, at: string, priceUsd: number | null = 0.02): ActivityLeg => ({
  txId: `${assetKey}${at}${qtyDelta}`,
  assetKey,
  sourceChain: "rbh",
  priceKey: assetKey,
  ticker: assetKey.toUpperCase(),
  contract: "0xabc",
  qtyDelta,
  kind: "swap",
  counterparty: null,
  priceUsd,
  at,
  checkedAt: at,
});
const noClose = () => null;

test("read times are each 08:00 UTC after the start, up to the end", () => {
  const t = readTimes(Date.parse("2026-09-26T10:00:00Z"), Date.parse("2026-09-28T08:00:00Z"));
  assert.deepEqual(t.map((x) => new Date(x).toISOString()), ["2026-09-27T08:00:00.000Z", "2026-09-28T08:00:00.000Z"]);
});

test("a day of buys into a new coin is one 'new' line, sized at the day's trade price", () => {
  // STATICS bought on 27 Sep (before 08:00 on the 28th), 80K held now.
  const legs = [leg("statics", 30_000, "2026-09-27T04:20:00Z"), leg("statics", 50_000, "2026-09-27T04:40:00Z")];
  const snap = Date.parse("2026-09-29T08:00:00Z");
  const m = backfillMovements(legs, new Map([["statics", 80_000]]), snap, readTimes(Date.parse("2026-09-22T08:00:00Z"), snap), noClose);
  assert.equal(m.length, 1);
  assert.equal(m[0].snapshotAt, "2026-09-27T08:00:00.000Z");
  assert.equal(m[0].kind, "new");
  assert.equal(m[0].qtyBefore, 0);
  assert.equal(m[0].qtyAfter, 80_000);
  assert.equal(m[0].usdDelta, 1_600);
});

test("a later sale is 'trimmed' against what was held then; a stored close wins over trade prices", () => {
  const legs = [leg("aurora", -987_512, "2026-09-28T07:00:00Z", 0.0632)];
  const snap = Date.parse("2026-09-29T08:00:00Z");
  const m = backfillMovements(legs, new Map([["aurora", 1_000_000]]), snap, readTimes(Date.parse("2026-09-22T08:00:00Z"), snap), (k, d) => (d === "2026-09-28" ? 0.06 : null));
  assert.equal(m[0].kind, "trimmed");
  assert.equal(m[0].qtyBefore, 1_987_512);
  assert.equal(m[0].priceUsd, 0.06);
});

test("a buy and a sale on the same day cancel; moves after the snapshot aren't in it; unsized coins have no line", () => {
  const snap = Date.parse("2026-09-29T08:00:00Z");
  const flip = [leg("gem", 100_000, "2026-09-25T01:00:00Z"), leg("gem", -100_000, "2026-09-25T03:00:00Z")];
  assert.deepEqual(backfillMovements(flip, new Map(), snap, readTimes(Date.parse("2026-09-22T08:00:00Z"), snap), noClose), []);
  const unsized = [leg("junk", 5_000_000, "2026-09-25T01:00:00Z", null)];
  assert.deepEqual(backfillMovements(unsized, new Map([["junk", 5_000_000]]), snap, readTimes(Date.parse("2026-09-22T08:00:00Z"), snap), noClose), []);
});

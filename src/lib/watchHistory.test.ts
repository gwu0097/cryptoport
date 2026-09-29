import test from "node:test";
import assert from "node:assert/strict";
import { windowBase } from "./watchHistory.ts";
import { coinDays, type ActivityLeg } from "./watchActivity.ts";

const DAY = 86_400_000;
const SNAPSHOT = Date.parse("2026-09-29T01:49:00Z");
const START = SNAPSHOT - 7 * DAY;
const leg = (assetKey: string, qtyDelta: number, at: string, over: Partial<ActivityLeg> = {}): ActivityLeg => ({
  txId: `${assetKey}${at}`,
  assetKey,
  sourceChain: "rbh",
  priceKey: assetKey,
  ticker: assetKey.toUpperCase(),
  qtyDelta,
  kind: "swap",
  counterparty: null,
  priceUsd: 0.01,
  at,
  checkedAt: at,
  ...over,
});

test("a coin bought in the window held its snapshot quantity minus the buys", () => {
  const legs = [leg("statics", 80_000, "2026-09-27T04:30:00Z")];
  const base = windowBase(new Map([["statics", { qty: 717_616, kept: false }]]), legs, SNAPSHOT, START);
  assert.equal(base.statics.qty, 637_616);
});

test("a coin sold out inside the window held what was sold (never a negative holding)", () => {
  // The second wallet had no AURORA at its read, but sold 987K in the window.
  const legs = [leg("aurora", -987_512, "2026-09-28T13:45:00Z", { sourceChain: "eth" })];
  const base = windowBase(new Map(), legs, SNAPSHOT, START);
  assert.equal(base.aurora.qty, 987_512);
  const [d] = coinDays([{ boundary: new Date(START).toISOString(), legs, base }], new Set());
  assert.equal(d.holdingQty, 0);
});

test("moves after the snapshot aren't in it, so they don't change the start", () => {
  const legs = [leg("gem", 100, "2026-09-26T00:00:00Z"), leg("gem", 50, "2026-09-29T03:00:00Z")];
  const base = windowBase(new Map([["gem", { qty: 100, kept: false }]]), legs, SNAPSHOT, START);
  assert.equal(base.gem.qty, 0);
});

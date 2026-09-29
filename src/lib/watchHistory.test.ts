import test from "node:test";
import assert from "node:assert/strict";
import { extendCoverage, mergeHistoryLegs, planHistoryReads, windowBase, HISTORY_FRESH_MS } from "./watchHistory.ts";
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


const NOW = Date.parse("2026-09-29T12:00:00Z");
const d = (days: number) => new Date(NOW - days * DAY).toISOString();

test("nothing stored: read everything; stored 7 days, asked for 30: only the older days, and newer if stale", () => {
  assert.deepEqual(planHistoryReads({}, ["eth"], NOW - 7 * DAY, NOW), [{ chain: "eth", kind: "all" }]);
  const cov = { eth: { from: d(7), to: d(0.5), fromBlock: "0x100", toBlock: "0x200" } };
  assert.deepEqual(planHistoryReads(cov, ["eth"], NOW - 30 * DAY, NOW), [
    { chain: "eth", kind: "older", toBlock: "0x100" },
    { chain: "eth", kind: "newer", fromBlock: "0x200" },
  ]);
  // Read minutes ago, 7 days asked: nothing to read at all.
  const fresh = { eth: { ...cov.eth, to: new Date(NOW - HISTORY_FRESH_MS / 2).toISOString() } };
  assert.deepEqual(planHistoryReads(fresh, ["eth"], NOW - 7 * DAY, NOW), []);
});

test("the same trade from the day's activity, a 7-day read and a 30-day read is kept once", () => {
  const a = leg("gem", 10, d(2));
  const merged = mergeHistoryLegs([a], [{ ...a }, leg("gem", 5, d(20))], NOW - 30 * DAY);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].at, d(20)); // oldest first
  assert.equal(mergeHistoryLegs(merged, [], NOW - 10 * DAY).length, 1); // older than kept: dropped
});

test("coverage grows at the right end; a capped read only claims as far back as it got", () => {
  const first = extendCoverage(undefined, { kind: "all", readFrom: d(7), readTo: d(0), oldestBlock: "0x100", newestBlock: "0x200" }, NOW - 30 * DAY);
  const older = extendCoverage(first, { kind: "older", readFrom: d(18), readTo: d(0), oldestBlock: "0x50", newestBlock: "0x99" }, NOW - 30 * DAY);
  assert.deepEqual(older, { from: d(18), to: d(0), fromBlock: "0x50", toBlock: "0x200" });
  const newer = extendCoverage(older, { kind: "newer", readFrom: d(0), readTo: d(-0.1), oldestBlock: "0x201", newestBlock: "0x230" }, NOW - 30 * DAY);
  assert.equal(newer.toBlock, "0x230");
  assert.equal(newer.fromBlock, "0x50");
});

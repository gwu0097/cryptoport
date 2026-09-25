import test from "node:test";
import assert from "node:assert/strict";
import { isFresh, splitByFreshness, SYNC_PRICE_MAX_AGE_MS } from "./priceCache.ts";

const NOW = Date.parse("2026-09-25T04:00:00Z");

test("fresh = fetched within the window; missing, future or unparseable timestamps aren't", () => {
  assert.equal(isFresh("2026-09-25T03:58:00Z", NOW, SYNC_PRICE_MAX_AGE_MS), true);
  assert.equal(isFresh("2026-09-25T03:54:59Z", NOW, SYNC_PRICE_MAX_AGE_MS), false);
  assert.equal(isFresh(null, NOW, SYNC_PRICE_MAX_AGE_MS), false);
  assert.equal(isFresh("garbage", NOW, SYNC_PRICE_MAX_AGE_MS), false);
  assert.equal(isFresh("2026-09-25T04:10:00Z", NOW, SYNC_PRICE_MAX_AGE_MS), false, "clock skew never counts as fresh");
});

test("splitByFreshness partitions keys by their cache timestamp", () => {
  const at: Record<string, string | null> = { a: "2026-09-25T03:59:00Z", b: null, c: "2026-09-25T03:00:00Z" };
  assert.deepEqual(splitByFreshness(["a", "b", "c"], (k) => at[k], NOW, SYNC_PRICE_MAX_AGE_MS), { fresh: ["a"], stale: ["b", "c"] });
});

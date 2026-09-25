import test from "node:test";
import assert from "node:assert/strict";
import { pricesAsOf, isStalePrice } from "./pricesAsOf.ts";

test("the bulk's time, plus coins lagging it by over an hour, named once, oldest first", () => {
  const r = pricesAsOf([
    { label: "BTC", at: "2026-09-25T18:00:00Z" },
    { label: "ETH", at: "2026-09-25T17:59:00Z" },
    { label: "LRC", at: "2026-09-22T10:00:00Z" },
    { label: "GAL", at: "2026-09-23T10:00:00Z" },
    { label: "LRC", at: "2026-09-22T10:00:00Z" },
    { label: "NEW", at: null },
  ]);
  assert.equal(r.newestAt, "2026-09-25T18:00:00.000Z");
  assert.deepEqual(r.stale.map((s) => s.label), ["LRC", "GAL"]);
});

test("nothing priced yet: no time, nothing stale", () => {
  assert.deepEqual(pricesAsOf([{ label: "X", at: null }]), { newestAt: null, stale: [] });
});

test("isStalePrice compares against the newest", () => {
  assert.equal(isStalePrice("2026-09-25T16:00:00Z", "2026-09-25T18:00:00Z"), true);
  assert.equal(isStalePrice("2026-09-25T17:30:00Z", "2026-09-25T18:00:00Z"), false);
  assert.equal(isStalePrice(null, "2026-09-25T18:00:00Z"), false);
});

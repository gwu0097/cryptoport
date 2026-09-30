import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_SYNC_MAX, canAutoSync, dueForAutoSync } from "./autoSync.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const w = (id: string, over: Partial<Parameters<typeof dueForAutoSync>[0][number]> = {}) => ({ id, mode: "auto", provider: null, address: "0xabc", auto_sync: true, last_refresh_at: hoursAgo(30), exchange_synced_at: null, ...over });

test("a marked wallet syncs once a day: synced 23h ago waits, 25h ago or never goes", () => {
  const due = dueForAutoSync([w("recent", { last_refresh_at: hoursAgo(23) }), w("old", { last_refresh_at: hoursAgo(25) }), w("never", { last_refresh_at: null })], NOW);
  assert.deepEqual(due.map((x) => x.id), ["never", "old"]);
});

test("only marked, syncable wallets; an exchange goes by its own sync time", () => {
  const due = dueForAutoSync(
    [w("unmarked", { auto_sync: false }), w("manual", { mode: "manual" }), w("noaddr", { address: null }), w("cex", { mode: "manual", provider: "kraken", address: null, last_refresh_at: null, exchange_synced_at: hoursAgo(2) }), w("cex-old", { mode: "manual", provider: "coinbase", address: null, exchange_synced_at: hoursAgo(48) })],
    NOW,
  );
  assert.deepEqual(due.map((x) => x.id), ["cex-old"]);
  assert.equal(canAutoSync({ mode: "manual", provider: null, address: null }), false);
});

test("never more than the cap, oldest first", () => {
  const many = Array.from({ length: 8 }, (_, i) => w(`w${i}`, { last_refresh_at: hoursAgo(30 + i) }));
  const due = dueForAutoSync(many, NOW);
  assert.equal(due.length, AUTO_SYNC_MAX);
  assert.equal(due[0].id, "w7");
});

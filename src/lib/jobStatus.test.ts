import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveJobStatus, JOB_STALE_MS } from "./jobStatus.ts";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

test("null status: nothing has ever run", () => {
  const s = deriveJobStatus({ status: null, started_at: null }, NOW);
  assert.equal(s.running, false);
  assert.equal(s.stale, false);
  assert.equal(s.outcome, null);
});

test("syncing, recently started: running", () => {
  const startedAt = new Date(NOW - 10_000).toISOString();
  const s = deriveJobStatus({ status: "syncing", started_at: startedAt }, NOW);
  assert.equal(s.running, true);
  assert.equal(s.stale, false);
  assert.equal(s.outcome, null);
});

test("refreshing, recently started: running (price refresh's own marker)", () => {
  const startedAt = new Date(NOW - 5_000).toISOString();
  const s = deriveJobStatus({ status: "refreshing", started_at: startedAt }, NOW);
  assert.equal(s.running, true);
});

test("syncing, started past JOB_STALE_MS ago: stale, not running, timed-out", () => {
  const startedAt = new Date(NOW - JOB_STALE_MS - 1_000).toISOString();
  const s = deriveJobStatus({ status: "syncing", started_at: startedAt }, NOW);
  assert.equal(s.running, false);
  assert.equal(s.stale, true);
  assert.equal(s.outcome, "timed-out");
});

test("syncing, exactly at the stale boundary: not yet stale", () => {
  const startedAt = new Date(NOW - JOB_STALE_MS + 1_000).toISOString();
  const s = deriveJobStatus({ status: "syncing", started_at: startedAt }, NOW);
  assert.equal(s.running, true);
  assert.equal(s.stale, false);
});

test("terminal 'ok': not running, ok outcome", () => {
  const s = deriveJobStatus({ status: "ok", started_at: new Date(NOW - 60_000).toISOString() }, NOW);
  assert.equal(s.running, false);
  assert.equal(s.outcome, "ok");
});

test("terminal 'error: ...': error outcome", () => {
  const s = deriveJobStatus({ status: "error: RPC timed out", started_at: null }, NOW);
  assert.equal(s.running, false);
  assert.equal(s.outcome, "error");
  assert.equal(s.detail, "error: RPC timed out");
});

test("terminal 'partial — ...': partial outcome", () => {
  const s = deriveJobStatus({ status: "partial — eth: 3 unverified", started_at: null }, NOW);
  assert.equal(s.outcome, "partial");
});

test("terminal 'N/M ticker(s) failed' (refreshPrices' own shape): partial outcome", () => {
  const s = deriveJobStatus({ status: "3/50 ticker(s) failed", started_at: null }, NOW);
  assert.equal(s.outcome, "partial");
});

test("terminal 'no priced holdings': ok outcome, not misread as an error", () => {
  const s = deriveJobStatus({ status: "no priced holdings", started_at: null }, NOW);
  assert.equal(s.outcome, "ok");
});

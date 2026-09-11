import test from "node:test";
import assert from "node:assert/strict";
import { blendedChange, walletHealthIssue } from "./dashboard.ts";

test("blendedChange returns null when nothing has 24h data", () => {
  assert.equal(blendedChange([{ total: 100, change24h: null }]), null);
});

test("blendedChange returns null for an empty list", () => {
  assert.equal(blendedChange([]), null);
});

test("blendedChange weights by value, not a simple average", () => {
  // $900 up 10%, $100 down 10% — dollar-weighted result should be close to
  // +8%, not the naive average of 0%.
  const result = blendedChange([
    { total: 900, change24h: 10 },
    { total: 100, change24h: -10 },
  ]);
  assert.ok(result);
  assert.equal(result.usd, 900 * 0.1 + 100 * -0.1);
  assert.ok(Math.abs(result.pct - 8) < 0.001);
  assert.equal(result.coveragePct, 100);
});

test("blendedChange excludes unpriced/no-change groups from both the average and the coverage numerator", () => {
  const result = blendedChange([
    { total: 100, change24h: 10 },
    { total: 900, change24h: null },
  ]);
  assert.ok(result);
  assert.equal(result.pct, 10); // only the $100 group counts
  assert.equal(result.coveragePct, 10); // $100 of $1000 total
});

test("blendedChange with a single covered holding matches its own change exactly", () => {
  const result = blendedChange([{ total: 50, change24h: -25 }]);
  assert.ok(result);
  assert.equal(result.pct, -25);
  assert.equal(result.coveragePct, 100);
});

test("walletHealthIssue never flags a manual wallet", () => {
  assert.equal(
    walletHealthIssue({ mode: "manual", last_refresh_at: null, last_refresh_status: null }),
    null,
  );
});

test("walletHealthIssue flags an auto wallet that has never synced", () => {
  const issue = walletHealthIssue({ mode: "auto", last_refresh_at: null, last_refresh_status: null });
  assert.deepEqual(issue, { kind: "never_synced" });
});

test("walletHealthIssue flags an auto wallet whose last sync is older than the stale threshold", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const lastRefreshAt = "2026-01-01T00:00:00Z"; // 24h ago exactly
  const issue = walletHealthIssue({ mode: "auto", last_refresh_at: lastRefreshAt, last_refresh_status: "ok" }, now);
  assert.deepEqual(issue, { kind: "stale" });
});

test("walletHealthIssue doesn't flag a recently-synced, ok-status auto wallet", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const lastRefreshAt = "2026-01-01T23:00:00Z"; // 1h ago
  const issue = walletHealthIssue({ mode: "auto", last_refresh_at: lastRefreshAt, last_refresh_status: "ok" }, now);
  assert.equal(issue, null);
});

test("walletHealthIssue doesn't treat an in-progress sync as a failure", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const lastRefreshAt = "2026-01-01T23:00:00Z"; // 1h ago, still fresh
  const issue = walletHealthIssue({ mode: "auto", last_refresh_at: lastRefreshAt, last_refresh_status: "syncing" }, now);
  assert.equal(issue, null);
});

test("walletHealthIssue surfaces a real failure status verbatim", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const lastRefreshAt = "2026-01-01T23:00:00Z";
  const issue = walletHealthIssue(
    { mode: "auto", last_refresh_at: lastRefreshAt, last_refresh_status: "error: RPC timeout" },
    now,
  );
  assert.deepEqual(issue, { kind: "failed", status: "error: RPC timeout" });
});

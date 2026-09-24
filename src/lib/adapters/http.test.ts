import test from "node:test";
import assert from "node:assert/strict";
import { retryDelayMs } from "./http.ts";

test("retries back off exponentially with ±20% jitter", () => {
  assert.equal(retryDelayMs(1, 4000, null, 0.5), 4000);
  assert.equal(retryDelayMs(2, 4000, null, 0.5), 8000);
  assert.equal(retryDelayMs(3, 4000, null, 0.5), 16000);
  assert.equal(retryDelayMs(1, 4000, null, 0), 3200);
  assert.equal(retryDelayMs(1, 4000, null, 1), 4800);
});

test("never sooner than the server's Retry-After (seconds or HTTP date), capped at 30s", () => {
  assert.equal(retryDelayMs(1, 1000, "12", 0.5), 12_000);
  assert.equal(retryDelayMs(1, 1000, "120", 0.5), 30_000);
  assert.equal(retryDelayMs(3, 4000, "2", 0.5), 16_000, "backoff wins when longer");
  const now = Date.parse("2026-09-24T01:00:00Z");
  assert.equal(retryDelayMs(1, 1000, "Thu, 24 Sep 2026 01:00:20 GMT", 0.5, now), 20_000);
  assert.equal(retryDelayMs(1, 1000, "garbage", 0.5), 1000);
});

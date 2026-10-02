import test from "node:test";
import assert from "node:assert/strict";
import { allow, type Limiter } from "./rateLimit.ts";

test("a key gets `limit` uses per window, then waits for the next window", () => {
  const l: Limiter = new Map();
  for (let i = 0; i < 3; i++) assert.equal(allow(l, "u", 3, 60_000, 1_000 + i), true);
  assert.equal(allow(l, "u", 3, 60_000, 5_000), false);
  assert.equal(allow(l, "other", 3, 60_000, 5_000), true);
  assert.equal(allow(l, "u", 3, 60_000, 61_001), true); // a new window
});

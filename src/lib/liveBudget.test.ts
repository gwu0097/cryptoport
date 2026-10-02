import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_MAX_PER_MIN, monthlyCredits, txPerMinute } from "./liveBudget.ts";

test("a bot-like address is well over the limit; a trader isn't", () => {
  const now = 1_790_000_000;
  const bot = Array.from({ length: 200 }, (_, i) => now - Math.floor(i / 10)); // 200 in ~20 s
  assert.ok(txPerMinute(bot)! > LIVE_MAX_PER_MIN);
  const trader = Array.from({ length: 200 }, (_, i) => now - i * 30); // one every 30 s
  assert.ok(Math.abs(txPerMinute(trader)! - 2) < 0.05);
  assert.equal(txPerMinute([]), 0);
  assert.equal(monthlyCredits(6), 259_200);
});

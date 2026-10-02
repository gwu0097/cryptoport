import test from "node:test";
import assert from "node:assert/strict";
import { dayCount, LIVE_DAY_MAX, monthlyCredits } from "./liveBudget.ts";

const NOW = 1_790_000_000;

test("a day's volume decides, not a burst: Risk's 3,577 with a 646-trade hour passes; a bot doesn't", () => {
  const risk = [...Array.from({ length: 646 }, (_, i) => NOW - i * 5), ...Array.from({ length: 2_931 }, (_, i) => NOW - 4_000 - i * 25)];
  assert.deepEqual(dayCount(risk, NOW, true), { count: 3_577, overLimit: false });
  const bot = Array.from({ length: 10_000 }, (_, i) => NOW - Math.floor(i / 50)); // 10,000 in ~3 minutes, read stopped there
  assert.equal(dayCount(bot, NOW, false).overLimit, true);
  assert.equal(dayCount(Array.from({ length: LIVE_DAY_MAX + 1 }, () => NOW), NOW, true).overLimit, true);
  assert.equal(dayCount([NOW - 90_000], NOW, true).count, 0); // older than a day
  assert.equal(monthlyCredits(3_577), 107_310);
});

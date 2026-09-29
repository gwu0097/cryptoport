import test from "node:test";
import assert from "node:assert/strict";
import { mintsToLookUp, mintsToShieldCheck, type CachedTokenInfo } from "./solanaTokenCache.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const row = (mint: string, usdPrice: number | null, checkedAt: string, liquidity = 1e6): CachedTokenInfo => ({ mint, symbol: mint.toUpperCase(), icon: null, usdPrice, liquidity, checkedAt });

test("a new mint is looked up; a shown one every read; valuable dust daily; dead dust weekly", () => {
  const cached = new Map([
    ["shown", row("shown", 1, hoursAgo(1))], // 100 × $1 = $100
    ["dust-hot", row("dust-hot", 0.01, hoursAgo(25))], // 100 × $0.01 = $1, checked 25 h ago
    ["dust-hot-fresh", row("dust-hot-fresh", 0.01, hoursAgo(2))],
    ["dead", row("dead", null, hoursAgo(24 * 3))],
    ["dead-old", row("dead-old", 0.000001, hoursAgo(24 * 8))],
  ]);
  const held = ["new", "shown", "dust-hot", "dust-hot-fresh", "dead", "dead-old"].map((mint) => ({ mint, amount: 100 }));
  assert.deepEqual(mintsToLookUp(held, cached, NOW), ["new", "shown", "dust-hot", "dead-old"]);
});

test("the 8,417-mint wallet: after its first read, a day later only the shown and expired ones", () => {
  const cached = new Map<string, CachedTokenInfo>();
  const held = Array.from({ length: 8_417 }, (_, i) => ({ mint: `m${i}`, amount: 1_000 }));
  // 88 shown; the rest dead, checked on a rolling week (1/7 of them > 7 days ago).
  held.forEach(({ mint }, i) => cached.set(mint, row(mint, i < 88 ? 1 : null, hoursAgo(i % 7 === 0 && i >= 88 ? 24 * 7 + 1 : 20))));
  const n = mintsToLookUp(held, cached, NOW).length;
  assert.ok(n < 1_400, `looked up ${n}`); // ~14 calls of 100, not ~85
});

test("a dead coin with a nominal price on a tiny pool waits a week, however large the balance", () => {
  const cached = new Map([["zombie", row("zombie", 0.001, "2026-09-28T12:00:00Z", 800)]]); // 1M × $0.001 = $1,000, $800 pool
  assert.deepEqual(mintsToLookUp([{ mint: "zombie", amount: 1_000_000 }], cached, NOW), []);
});

test("Shield: a priced candidate every read; a named unpriced one weekly", () => {
  const cached = new Map<string, CachedTokenInfo>([
    ["dead-checked", { ...row("dead-checked", null, hoursAgo(1)), unsellable: true, shieldCheckedAt: hoursAgo(24) }],
    ["dead-old", { ...row("dead-old", null, hoursAgo(1)), unsellable: true, shieldCheckedAt: hoursAgo(24 * 8) }],
  ]);
  const got = mintsToShieldCheck(
    [
      { mint: "real", priced: true },
      { mint: "dead-checked", priced: false },
      { mint: "dead-old", priced: false },
      { mint: "dead-new", priced: false },
    ],
    cached,
    NOW,
  );
  assert.deepEqual(got, ["real", "dead-old", "dead-new"]);
});

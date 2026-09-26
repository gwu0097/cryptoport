import test from "node:test";
import assert from "node:assert/strict";
import { attribute, daysBefore } from "./attribution.ts";
import { dailyReturns, maxDrawdown, riskProfile, MIN_COMMON_DAYS } from "./risk.ts";
import { holdingContext } from "./holdingContext.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** `n` consecutive days ending 2026-09-26, price per day from `f(i)`. */
function series(n: number, f: (i: number) => number, end = "2026-09-26"): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < n; i++) m.set(daysBefore(end, n - 1 - i), f(i));
  return m;
}

test("attribution: price effect is today's value minus the same holding at the start", () => {
  const a = attribute(
    "7d",
    [
      { key: "solana", ticker: "SOL", valueUsd: 110, change: { "24h": 1, "7d": 10, "30d": null } },
      { key: "jup:x", ticker: "X", valueUsd: 50, change: { "24h": 2, "7d": null, "30d": null } },
    ],
    { usd: 40, tickers: ["BTC-PERP"] },
    200,
    [{ date: "2026-09-19", total: 150 }],
    "2026-09-26",
  );
  close(a.priceUsd, 10); // 110 − 110/1.1
  assert.deepEqual(a.base, { date: "2026-09-19", totalUsd: 150 });
  assert.equal(a.actualUsd, 50);
  close(a.otherUsd!, 40);
  assert.deepEqual(a.unattributed, { usd: 90, tickers: ["BTC-PERP", "X"] });
});

test("attribution: no snapshot for the start day → actual change unknown, not 0", () => {
  const a = attribute("30d", [], { usd: 0, tickers: [] }, 100, [{ date: "2026-09-25", total: 90 }], "2026-09-26");
  assert.equal(a.base, null);
  assert.equal(a.actualUsd, null);
  assert.equal(a.otherUsd, null);
});

test("daily returns only between consecutive days", () => {
  const r = dailyReturns(new Map([["2026-09-01", 100], ["2026-09-02", 110], ["2026-09-05", 121]]));
  assert.deepEqual([...r], [["2026-09-02", 0.10000000000000009]]);
});

test("max drawdown compounds returns", () => {
  close(maxDrawdown([0.1, -0.5, 0.2]), -0.5);
  assert.equal(maxDrawdown([0.1, 0.1]), 0);
});

test("risk: an asset that moves 2× BTC has beta 2; a stablecoin is cash-like with no risk", () => {
  const n = 60;
  const btcMoves = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 0.02 : i % 3 === 1 ? -0.01 : 0.005));
  const walk = (k: number) => {
    let p = 100;
    return series(n, (i) => (i === 0 ? p : (p *= 1 + k * btcMoves[i])));
  };
  const btc = walk(1);
  const r = riskProfile(
    [
      { key: "alt", ticker: "ALT", valueUsd: 500, prices: walk(2) },
      { key: "usdc", ticker: "USDC", valueUsd: 500, prices: series(n, () => 1) },
      { key: "new", ticker: "NEW", valueUsd: 100, prices: series(5, () => 3) },
      { key: "pos", ticker: "LP", valueUsd: 50, prices: undefined },
    ],
    btc,
  )!;
  assert.equal(r.days, n - 1);
  assert.deepEqual(r.unmodeled, { usd: 150, tickers: ["NEW", "LP"] });
  const alt = r.assets.find((a) => a.key === "alt")!;
  close(alt.beta!, 2, 1e-6);
  close(alt.riskShare, 1, 1e-9);
  close(r.beta!, 1, 1e-6); // half in ALT (β 2), half cash
  close(r.btcDrop20Usd!, -200, 1e-6); // 500 × 2 × −20%
  assert.equal(r.cashLikeUsd, 500);
});

test("risk: too little common history → no profile", () => {
  assert.equal(riskProfile([{ key: "a", ticker: "A", valueUsd: 1, prices: series(MIN_COMMON_DAYS - 5, (i) => 1 + i) }], undefined), null);
});

test("holding context: range, drawdown and flags", () => {
  const prices = series(90, (i) => (i < 45 ? 100 : 40));
  const c = holdingContext(
    { key: "x", ticker: "X", iconUrl: null, valueUsd: 30_000, price: 40, change7d: 0, change30d: -60, marketCap: 20_000_000, volume24h: 1_000_000, prices, risk: null },
    100_000,
    "2026-09-26",
  );
  close(c.fromHigh!, -0.6);
  assert.equal(c.rangePosition, 0);
  assert.deepEqual(c.flags.map((f) => f.id), ["large", "nearLow", "deepDrawdown", "thinMarket", "smallCap"]);
});

test("holding context: too few prices → no range, never a guess", () => {
  const c = holdingContext(
    { key: "x", ticker: "X", iconUrl: null, valueUsd: 1, price: 2, change7d: null, change30d: null, marketCap: null, volume24h: null, prices: series(3, () => 2), risk: null },
    100,
    "2026-09-26",
  );
  assert.equal(c.fromHigh, null);
  assert.equal(c.rangePosition, null);
  assert.equal(c.volumeShare, null);
  assert.deepEqual(c.flags, []);
});

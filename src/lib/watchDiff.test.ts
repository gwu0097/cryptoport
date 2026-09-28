import test from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, MOVE_MIN_USD } from "./watchDiff.ts";
import type { SnapshotRow, WatchSnapshot } from "./watchSnapshot.ts";

const snap = (rows: SnapshotRow[], unrecognized: WatchSnapshot["unrecognized"] = []): WatchSnapshot => ({ rows, unrecognized });
const coin = (ticker: string, qty: number, chain = "ethereum", price_key = ticker.toLowerCase(), contract?: string): SnapshotRow => ({ ticker, qty, chain, category: "token", price_key, contract });
const prices: Record<string, number> = { eth: 2000, "usd-coin": 1, pepe: 0.00001, wif: 2 };
const priceOf = (a: { priceKey: string | null; type: string }) => (a.type === "token" ? (a.priceKey && a.priceKey in prices ? prices[a.priceKey] : null) : 1000);

test("the first read produces nothing", () => {
  assert.deepEqual(diffSnapshots(null, snap([coin("ETH", 1, "ethereum", "eth")]), priceOf), []);
});

test("new, added, trimmed and exited, sized at today's price", () => {
  const before = snap([coin("ETH", 10, "ethereum", "eth"), coin("WIF", 1000, "solana", "wif"), coin("USDC", 5000, "base", "usd-coin")]);
  const after = snap([coin("ETH", 12, "ethereum", "eth"), coin("WIF", 400, "solana", "wif"), coin("PEPE", 1e8, "ethereum", "pepe")]);
  const m = diffSnapshots(before, after, priceOf);
  assert.deepEqual(
    m.map((x) => [x.ticker, x.kind, Math.round(x.usdDelta!)]),
    [
      ["USDC", "exited", -5000],
      ["ETH", "added", 4000],
      ["WIF", "trimmed", -1200],
      ["PEPE", "new", 1000],
    ],
  );
});

test("price moves and small changes are not movements", () => {
  const before = snap([coin("ETH", 10, "ethereum", "eth"), coin("WIF", 1000, "solana", "wif")]);
  // ETH +0.5% of quantity ($200 but under 1%); WIF +40 ($80, under $100).
  const after = snap([coin("ETH", 10.05, "ethereum", "eth"), coin("WIF", 1040, "solana", "wif")]);
  assert.deepEqual(diffSnapshots(before, after, priceOf), []);
  assert.ok(MOVE_MIN_USD === 100);
});

test("an add of 1% counts, and a big add to a huge position counts whatever its share", () => {
  const before = snap([coin("ETH", 10, "ethereum", "eth"), coin("WIF", 1_000_000, "solana", "wif")]);
  // ETH +2% ($400); WIF +0.5% of a huge position, but $10,000 (≥ $5,000).
  const after = snap([coin("ETH", 10.2, "ethereum", "eth"), coin("WIF", 1_005_000, "solana", "wif")]);
  assert.deepEqual(
    diffSnapshots(before, after, priceOf).map((m) => [m.ticker, m.kind]),
    [["WIF", "added"], ["ETH", "added"]],
  );
});

test("the same coin on another chain is one asset: bridging isn't a movement", () => {
  const before = snap([coin("USDC", 5000, "ethereum", "usd-coin")]);
  const after = snap([coin("USDC", 3000, "ethereum", "usd-coin"), coin("USDC", 2000, "base", "usd-coin")]);
  assert.deepEqual(diffSnapshots(before, after, priceOf), []);
});

test("a row carried forward after a failed read never moves", () => {
  const before = snap([coin("ETH", 10, "ethereum", "eth")]);
  const after = snap([{ ...coin("ETH", 10, "ethereum", "eth"), kept: true }]);
  assert.deepEqual(diffSnapshots(before, after, priceOf), []);
  // …even when the kept quantity differs from a stale copy elsewhere.
  const after2 = snap([{ ...coin("ETH", 3, "ethereum", "eth"), kept: true }]);
  assert.deepEqual(diffSnapshots(before, after2, priceOf), []);
});

test("a token that lost its price today is still held, not exited", () => {
  const before = snap([coin("WIF", 1000, "solana", "wif", "WIFmint")]);
  const after = snap([], [{ chain: "solana", contract: "WIFmint", symbol: "WIF", amount: 1000 }]);
  assert.deepEqual(diffSnapshots(before, after, priceOf), []);
});

test("an unpriced or illiquid asset's change isn't reported (can't be sized)", () => {
  const before = snap([coin("JUNK", 1e9, "ethereum", "junk")]);
  const after = snap([coin("JUNK", 5e9, "ethereum", "junk")]);
  assert.deepEqual(diffSnapshots(before, after, priceOf), []);
});

test("venue cash never moves; perps compare by size and side", () => {
  const cash = (usd: number): SnapshotRow => ({ ticker: "USDC", qty: usd, usd_override: usd, chain: "hyperliquid", category: "defi", protocol: "Hyperliquid", display_label: "Perps Withdrawable" });
  const perp = (qty: number, side: "long" | "short"): SnapshotRow => ({ ticker: "BTC-PERP", qty, usd_override: 500, chain: "hyperliquid", category: "defi", position_side: side });
  const m = diffSnapshots(snap([cash(1000), perp(1, "long")]), snap([cash(9000), perp(3, "long"), perp(2, "short")]), priceOf);
  assert.deepEqual(m.map((x) => [x.assetKey, x.kind]), [
    ["perp:hyperliquid:BTC-PERP:long", "added"],
    ["perp:hyperliquid:BTC-PERP:short", "new"],
  ]);
});

test("a position whose remainder is worth under $1 is exited, not trimmed", () => {
  const m = diffSnapshots(snap([coin("ETH", 1, "ethereum", "eth")]), snap([coin("ETH", 0.0000001, "ethereum", "eth")]), priceOf);
  assert.equal(m[0].kind, "exited");
});

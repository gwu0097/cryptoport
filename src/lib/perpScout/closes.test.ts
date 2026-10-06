import test from "node:test";
import assert from "node:assert/strict";
import { recentCloses } from "./closes.ts";
import type { Fill } from "./entries.ts";

const H = 3_600_000;
const D = 24 * H;
const f = (time: number, side: "A" | "B", sz: number, start: number, px: number, closedPnl = 0, coin = "UNI"): Fill => ({ coin, px, sz, side, time, startPosition: start, oid: time, closedPnl });

test("a long opened, added to, trimmed and closed: one close with averages and return", () => {
  const now = 10 * D;
  const fills = [
    f(8 * D, "B", 10, 0, 9), // open 10 @ 9
    f(8 * D + H, "B", 10, 10, 10), // add 10 @ 10 → avg 9.5
    f(9 * D, "A", 5, 20, 11, 7.5), // trim
    f(9 * D + 2 * H, "A", 15, 15, 12, 37.5), // close
  ];
  const [c] = recentCloses("0xa", fills, now);
  assert.equal(c.side, "long");
  assert.equal(c.openedAt, 8 * D);
  assert.equal(c.closedAt, 9 * D + 2 * H);
  assert.equal(c.entryPx, 9.5);
  assert.equal(c.exitPx, (5 * 11 + 15 * 12) / 20);
  assert.equal(c.pnlUsd, 45);
  assert.ok(Math.abs((c.returnPct ?? 0) - ((235 / 20) / 9.5 - 1)) < 1e-12);
});

test("a short opened before the fills read: entry worked back from realized PnL", () => {
  const [c] = recentCloses("0xa", [f(5 * D, "B", 100, -100, 8.87, 32.9)], 6 * D);
  assert.equal(c.side, "short");
  assert.equal(c.openedAt, null);
  assert.ok(Math.abs((c.entryPx ?? 0) - (8.87 + 0.329)) < 1e-9);
  assert.ok((c.returnPct ?? 0) > 0, "a short closed below entry is a gain");
});

test("a flip closes one side and opens the other; still-open and old closes aren't listed", () => {
  const fills = [
    f(1 * D, "B", 10, 0, 100, 0, "BTC"), // long, closed 20 days before now: too old
    f(2 * D, "A", 10, 10, 110, 100, "BTC"),
    f(20 * D, "B", 5, 0, 50, 0, "SOL"),
    f(21 * D, "A", 8, 5, 55, 25, "SOL"), // flips: closes the long, opens a 3 short
  ];
  const closes = recentCloses("0xa", fills, 22 * D);
  assert.deepEqual(closes.map((c) => `${c.coin} ${c.side}`), ["SOL long"]);
  assert.equal(closes[0].size, 5);
  assert.equal(closes[0].exitPx, 55);
});

test("mergeCloses: no repeats, old ones dropped, opening time from the last scan's open position", async () => {
  const { mergeCloses } = await import("./closes.ts");
  const c = (coin: string, closedAt: number, openedAt: number | null = null) => ({ address: "0xa", coin, side: "long" as const, openedAt, closedAt, entryPx: 1, exitPx: 1.1, size: 1, pnlUsd: 0.1, returnPct: 0.1 });
  const now = 10 * D;
  const merged = mergeCloses([c("BTC", 9 * D, 8 * D), c("OLD", 1 * D)], [c("BTC", 9 * D, 8 * D), c("ETH", 9.5 * D)], now, new Map([["0xa:ETH:long", 7 * D]]));
  assert.deepEqual(merged.map((x) => x.coin), ["ETH", "BTC"]);
  assert.equal(merged[0].openedAt, 7 * D);
});

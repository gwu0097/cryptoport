import test from "node:test";
import assert from "node:assert/strict";
import { parseFills, positionOpening, buildEntries, moveInFavour, accountLeverage, netBias, liveFigures, positionRole, latestMove, type Fill, type ScoutAccountState, type ScoutEntry } from "./entries.ts";

const fill = (time: number, side: "A" | "B", sz: number, start: number, px: number, oid = time, coin = "ADA"): Fill => ({ coin, px, sz, side, time, startPosition: start, oid });

test("parseFills keeps well-formed fills", () => {
  const f = parseFills([{ coin: "ADA", px: "0.5", sz: "10", side: "A", time: 5, startPosition: "0", oid: 9, dir: "Open Short" }, { coin: "X" }]);
  assert.deepEqual(f, [{ coin: "ADA", px: 0.5, sz: 10, side: "A", time: 5, startPosition: 0, oid: 9 }]);
  assert.throws(() => parseFills({}));
});

test("opening of a short: the fill that took it from flat, its order's average price, and the last add", () => {
  const fills = [
    fill(1, "B", 5, 0, 1.0), // an earlier long
    fill(2, "A", 5, 5, 1.1), // closed flat
    fill(3, "A", 4, 0, 0.9, 77), // opens the short (order 77, two fills)
    fill(4, "A", 6, -4, 0.8, 77),
    fill(9, "A", 10, -10, 0.7, 88), // adds
    fill(10, "B", 2, -20, 0.6, 99), // trims
  ].reverse();
  const o = positionOpening(fills, "ADA", -18);
  assert.equal(o.openedAt, 3);
  assert.ok(Math.abs((o.openPx ?? 0) - (4 * 0.9 + 6 * 0.8) / 10) < 1e-12);
  assert.equal(o.lastAddAt, 9);
  assert.equal(o.lastTrimAt, 10);
  assert.equal(o.openedBefore, null);
});

test("a flip opens the new side", () => {
  const o = positionOpening([fill(1, "B", 10, 0, 1), fill(2, "A", 15, 10, 2)], "ADA", -5);
  assert.equal(o.openedAt, 2);
  assert.equal(o.openPx, 2);
});

test("opened before the fills read: unknown, with the oldest fill as the bound; adds still seen", () => {
  const o = positionOpening([fill(50, "B", 1, 3, 1), fill(40, "A", 1, 1, 1, 40, "BTC")], "ADA", 4);
  assert.deepEqual(o, { openedAt: null, openPx: null, lastAddAt: 50, lastTrimAt: null, openedBefore: 40 });
  const trimmed = positionOpening([fill(50, "A", 1, 3, 1)], "ADA", 2);
  assert.equal(trimmed.lastAddAt, null, "a trim isn't an add");
  assert.equal(trimmed.lastTrimAt, 50);
  assert.equal(positionOpening([], "ADA", 1).openedBefore, null);
});

const state: ScoutAccountState = {
  marginSummary: { accountValue: "1000" },
  crossMarginSummary: { accountValue: "1000" },
  withdrawable: "100",
  assetPositions: [
    { type: "oneWay", position: { coin: "ADA", szi: "-100", entryPx: "1.0", positionValue: "80", liquidationPx: "3", unrealizedPnl: "20", marginUsed: "8", leverage: { type: "cross", value: 10 }, returnOnEquity: "2.5" } },
    { type: "oneWay", position: { coin: "BTC", szi: "0.01", entryPx: "60000", positionValue: "620", liquidationPx: null, unrealizedPnl: "20", marginUsed: "62", leverage: { type: "isolated", value: 10 }, returnOnEquity: "0.3" } },
    { type: "oneWay", position: { coin: "ETH", szi: "0", entryPx: "1", liquidationPx: null, unrealizedPnl: "0", marginUsed: "0", leverage: { type: "cross", value: 1 }, returnOnEquity: "0" } },
  ],
};

test("buildEntries: mark from position value, share of equity, nearest TP/SL", () => {
  const orders = [
    { coin: "ADA", side: "B" as const, sz: "100", triggerPx: "0.5", isTrigger: true, isPositionTpsl: true, reduceOnly: true, orderType: "Take Profit Market" },
    { coin: "ADA", side: "B" as const, sz: "100", triggerPx: "1.5", isTrigger: true, isPositionTpsl: true, reduceOnly: true, orderType: "Stop Market" },
  ];
  const [ada, btc] = buildEntries("0xa", state, [fill(3, "A", 100, 0, 1.0)], orders);
  assert.equal(ada.side, "short");
  assert.equal(ada.markPx, 0.8);
  assert.equal(ada.equityShare, 0.08);
  assert.equal(ada.tp, 0.5);
  assert.equal(ada.sl, 1.5);
  assert.equal(ada.openedAt, 3);
  assert.equal(btc.liquidationPx, null);
  assert.equal(btc.tp, null);
  assert.equal(btc.tpslKnown, true);
  assert.equal(buildEntries("0xa", state, [], null)[0].tpslKnown, false);
});

test("moveInFavour: negative means price is better than their entry", () => {
  assert.ok(Math.abs((moveInFavour("long", 100, 90) ?? 0) + 0.1) < 1e-12, "long, price below entry");
  assert.ok(Math.abs((moveInFavour("short", 100, 110) ?? 0) + 0.1) < 1e-12, "short, price above entry");
  assert.ok((moveInFavour("short", 100, 80) ?? 0) > 0);
  assert.equal(moveInFavour("long", null, 1), null);
  assert.equal(moveInFavour("long", 0, 1), null);
});

test("account leverage and net bias", () => {
  assert.equal(accountLeverage(state), 0.7);
  assert.equal(accountLeverage(state, 3500), 0.2, "a unified account: the whole account's value");
  assert.equal(buildEntries("0xa", state, [], null, 8000)[0].equityShare, 0.01);
  const entries = buildEntries("0xa", state, [], null);
  assert.ok(Math.abs((netBias(entries) ?? 0) - (620 - 80) / 700) < 1e-12);
  assert.equal(netBias([]), null);
});

test("liveFigures: a newer mid replaces the scan's mark", () => {
  const [ada] = buildEntries("0xa", state, [fill(3, "A", 100, 0, 1.2)], null);
  const scan = liveFigures(ada, undefined);
  assert.equal(scan.mark, 0.8);
  assert.ok(Math.abs((scan.pnlUsd ?? 0) - 20) < 1e-9, "short 100 from 1.0 to 0.8");
  const live = liveFigures(ada, 1.1);
  assert.ok(Math.abs((live.pnlUsd ?? 0) + 10) < 1e-9);
  assert.ok(Math.abs((live.notionalUsd ?? 0) - 110) < 1e-9);
  assert.ok((live.vsEntry ?? 0) < 0, "price above a short's entry: better than theirs");
  assert.ok((live.vsOpen ?? 0) > 0, "still below their first fill at 1.2");
  assert.ok(Math.abs((scan.roe ?? 0) - 0.2 * 10) < 1e-9, "20% move at 10x: +200% on margin");
  assert.equal(liveFigures({ ...ada, leverage: null }, undefined).roe, null);
});

test("positionRole: pair, hedge, book leg, directional", () => {
  const e = (coin: string, side: "long" | "short", notional: number, openedAt: number | null = null) =>
    ({ address: "0xa", coin, side, notionalUsd: notional, openedAt }) as ScoutEntry;
  const H = 3_600_000;
  // Opened together on opposite sides: a pair, whatever the book's lean.
  const zro = e("ZRO", "long", 100, 10 * H), sui = e("SUI", "short", 100, 11 * H), eth = e("ETH", "long", 1000);
  assert.equal(positionRole(zro, [zro, sui, eth]).role, "pair");
  assert.match(positionRole(zro, [zro, sui, eth]).why, /SUI short/);
  // A BTC short against a page of longs: a hedge; the longs are directional.
  const btc = e("BTC", "short", 100), sol = e("SOL", "long", 500), avax = e("AVAX", "long", 500);
  assert.equal(positionRole(btc, [btc, sol, avax]).role, "hedge");
  assert.equal(positionRole(sol, [btc, sol, avax]).role, "directional");
  // A balanced long/short book: each is a leg.
  const ada = e("ADA", "short", 500), jup = e("JUP", "long", 480);
  assert.equal(positionRole(ada, [ada, jup]).role, "book");
  // Alone: directional.
  assert.equal(positionRole(ada, [ada]).role, "directional");
  // Opened far apart: not a pair.
  const a = e("A", "long", 100, 0), b = e("B", "short", 100, 5 * H);
  assert.equal(positionRole(a, [a, b]).role, "book");
});

test("latestMove: the newest of opened, added, trimmed", () => {
  assert.deepEqual(latestMove({ openedAt: 1, lastAddAt: 5, lastTrimAt: 3 }), { kind: "add", at: 5 });
  assert.deepEqual(latestMove({ openedAt: 9, lastAddAt: null, lastTrimAt: undefined }), { kind: "new", at: 9 });
  assert.deepEqual(latestMove({ openedAt: null, lastAddAt: 2, lastTrimAt: 7 }), { kind: "trim", at: 7 });
  assert.equal(latestMove({ openedAt: null, lastAddAt: null, lastTrimAt: null }), null);
});

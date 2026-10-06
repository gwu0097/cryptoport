import test from "node:test";
import assert from "node:assert/strict";
import { findTracked, resolveTracked, trackClose, trackOpen, trackedKey, type TrackedTrade } from "./tracked.ts";
import type { ScoutEntry } from "./entries.ts";
import type { ScoutClose } from "./closes.ts";

const H = 3_600_000;
const trade = (o: Partial<TrackedTrade> = {}): TrackedTrade => ({
  address: "0xa", coin: "HYPE", side: "long", openedAt: 10 * H, trackedAt: 12 * H,
  at: { entryPx: 90, price: 92, size: 100, leverage: 5, tp: 110, sl: 85 }, ...o,
});
const entry = (o: Partial<ScoutEntry> = {}) => ({
  address: "0xa", coin: "HYPE", side: "long", size: 100, notionalUsd: 9500, entryPx: 90, openPx: 90, openedAt: 10 * H, openedBefore: null,
  lastAddAt: null, lastTrimAt: null, markPx: 95, unrealizedPnl: 500, roe: 0.27, leverage: 5, marginMode: "cross", liquidationPx: null,
  equityShare: 0.1, tp: 110, sl: 85, tpslMore: 0, tpslKnown: true, ...o,
}) as ScoutEntry;
const close = (o: Partial<ScoutClose> = {}): ScoutClose => ({ address: "0xa", coin: "HYPE", side: "long", openedAt: 10 * H, closedAt: 20 * H, entryPx: 90, exitPx: 99, size: 100, pnlUsd: 900, returnPct: 0.1, ...o });

test("open: the same position, with the move since it was marked", () => {
  const v = resolveTracked(trade(), [entry()], []);
  assert.equal(v.status.kind, "open");
  assert.equal(v.price, 95);
  assert.ok(Math.abs((v.sinceTracked ?? 0) - (95 / 92 - 1)) < 1e-12);
  assert.ok(Math.abs((v.vsEntry ?? 0) - (95 / 90 - 1)) < 1e-12);
});

test("a later position in the same coin isn't the tracked one", () => {
  const v = resolveTracked(trade(), [entry({ openedAt: 30 * H })], [close()]);
  assert.equal(v.status.kind, "closed", "the tracked one closed; a new one opened after");
});

test("closed, stopped out, target hit, or gone", () => {
  assert.equal(resolveTracked(trade(), [], [close()]).status.kind, "closed");
  assert.equal(resolveTracked(trade(), [], [close({ exitPx: 85.2, returnPct: -0.053 })]).status.kind, "stopped");
  assert.equal(resolveTracked(trade(), [], [close({ exitPx: 109.8 })]).status.kind, "target");
  const gone = resolveTracked(trade(), [], []);
  assert.equal(gone.status.kind, "gone");
  assert.equal(gone.entryPx, 90, "as marked");
  const short = resolveTracked(trade({ side: "short", at: { entryPx: 100, price: 95, size: 1, leverage: 1, tp: null, sl: null } }), [], [close({ side: "short", exitPx: 90, returnPct: 0.1 })]);
  assert.ok((short.sinceTracked ?? 0) > 0, "a short closed below where it was marked: a gain since");
});

test("keys tell positions apart", () => {
  assert.notEqual(trackedKey(trade()), trackedKey(trade({ openedAt: 30 * H })));
  assert.equal(trackedKey(trade({ openedAt: null })), "0xa:HYPE:long:before");
});

test("a row finds its tracked trade; marking keeps the position's figures", () => {
  const t = trackOpen(entry(), 95, 12 * H);
  assert.deepEqual(t.at, { entryPx: 90, price: 95, size: 100, leverage: 5, tp: 110, sl: 85 });
  assert.equal(findTracked([t], entry()), t);
  assert.equal(findTracked([t], entry({ openedAt: 30 * H })), undefined, "a later position is another trade");
  const c = trackClose(close(), 21 * H);
  assert.equal(c.at.price, 99);
  assert.equal(findTracked([c], close()), c);
  assert.equal(resolveTracked(c, [], [close()]).status.kind, "closed");
});

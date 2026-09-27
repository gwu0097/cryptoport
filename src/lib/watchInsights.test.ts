import test from "node:test";
import assert from "node:assert/strict";
import { coinFlows, earlyOrLate, sharedHoldings, trackRecord, type InfluencerHoldings, type MovementInput, type PositionInput } from "./watchInsights.ts";

const holdings = (id: string, total: number, assets: [string, number][]): InfluencerHoldings => ({
  influencerId: id,
  name: id,
  totalUsd: total,
  assets: new Map(assets.map(([k, usd]) => [k, { ticker: k.toUpperCase(), priceKey: k, usd }])),
});

test("shared holdings need two holders with real conviction", () => {
  const s = sharedHoldings([
    holdings("a", 100_000, [["spx", 50_000], ["eth", 20]]),
    holdings("b", 1_000_000, [["spx", 10_000], ["eth", 100]]), // eth is dust for b
    holdings("c", 10_000, [["sol", 5_000], ["eth", 1_000]]),
  ]);
  assert.deepEqual(s.map((x) => [x.assetKey, x.holders.map((h) => h.influencerId)]), [["spx", ["a", "b"]]]);
  assert.equal(s[0].avgShare, (0.5 + 0.01) / 2);
});

const mv = (influencerId: string, assetKey: string, usdDelta: number, at: string, kind: MovementInput["kind"] = usdDelta > 0 ? "added" : "trimmed"): MovementInput => ({
  influencerId,
  assetKey,
  ticker: assetKey.toUpperCase(),
  priceKey: assetKey,
  kind,
  usdDelta,
  walletShare: 0.02,
  snapshotAt: at,
});

test("converging buys: coins several influencers bought, one vote each by net dollars", () => {
  const flows = coinFlows(
    [mv("a", "hype", 5000, "2026-09-20"), mv("b", "hype", 2000, "2026-09-22"), mv("b", "hype", -500, "2026-09-23"), mv("c", "hype", -3000, "2026-09-21"), mv("a", "wif", 900, "2026-09-21")],
    2,
  );
  assert.equal(flows.length, 1);
  assert.deepEqual(flows[0].buyers.map((b) => [b.influencerId, b.usd]), [["a", 5000], ["b", 1500]]);
  assert.deepEqual(flows[0].sellers.map((s) => s.influencerId), ["c"]);
  assert.equal(flows[0].netUsd, 3500);
  assert.equal(flows[0].firstBuyAt, "2026-09-20");
});

test("track record: only calls made since watching, closed at exit or open at today's price", () => {
  const p = (o: Partial<PositionInput>): PositionInput => ({ influencerId: "a", assetKey: "x", ticker: "X", priceKey: "x", heldAtStart: false, openedAt: "2026-09-01T00:00:00Z", entryPrice: 1, closedAt: null, exitPrice: null, ...o });
  const r = trackRecord(
    [
      p({ assetKey: "held", heldAtStart: true }),
      p({ assetKey: "win", closedAt: "2026-09-11T00:00:00Z", exitPrice: 1.5 }),
      p({ assetKey: "loss", closedAt: "2026-09-04T00:00:00Z", exitPrice: 0.8 }),
      p({ assetKey: "open", priceKey: "open" }),
    ],
    (k) => (k === "open" ? 2 : null),
    "2026-09-21T00:00:00Z",
  );
  assert.deepEqual(r.trades.map((t) => t.assetKey).sort(), ["loss", "open", "win"]);
  assert.equal(r.closed, 2);
  assert.equal(r.winRate, 0.5);
  assert.equal(r.medianHoldDays, 6.5);
  assert.equal(r.best?.assetKey, "open");
  assert.equal(r.worst?.assetKey, "loss");
});

test("no closed trades → no win rate, never 0%", () => {
  assert.equal(trackRecord([], () => null, "2026-09-21T00:00:00Z").winRate, null);
});

test("early or late needs history 30 days before entry", () => {
  const history = new Map([["2026-08-01", 0.5]]);
  const r = earlyOrLate("2026-08-31T12:00:00Z", 1, history, 3);
  assert.equal(r.before30d, 1); // already doubled before they bought
  assert.equal(r.since, 2);
  assert.deepEqual(earlyOrLate("2026-08-31T12:00:00Z", 1, undefined, null), { before30d: null, since: null });
});

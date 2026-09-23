import test from "node:test";
import assert from "node:assert/strict";
import { simulate, fundingSummer, netReturns, profitFactor, metricsOf, segments, randomTrades, rngFor, tradeReturns } from "./harness.ts";
import type { Rules } from "./rules.ts";
import type { Candle } from "../smc/engine.ts";

const H = 3600;
const candles = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ t: i * H, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
const rules = (n: number, entries: number[], exits: number[], fillOffset: 0 | 1 = 1): Rules => ({
  id: "rsi2",
  fillOffset,
  warmup: 0,
  entry: Array.from({ length: n }, (_, i) => entries.includes(i)),
  exit: Array.from({ length: n }, (_, i) => exits.includes(i)),
});

test("simulate: decide on bar i's close, fill at bar i+1's open (Delay = 1); exit checked only after the entry decision", () => {
  const cs = candles(10);
  const tr = simulate(rules(10, [2], [2, 5]), cs, 0, 9, H);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].entryPos, 3, "decided at 2, filled at 3's open");
  assert.equal(tr[0].entryPrice, cs[3].o);
  assert.equal(tr[0].exitPos, 6, "the same-bar exit at 2 is ignored; exit decided at 5, filled at 6");
  assert.equal(tr[0].forced, false);
});

test("simulate: SMC-style fillOffset 0 fills on the decision bar's own open", () => {
  const tr = simulate(rules(10, [2], [5], 0), candles(10), 0, 9, H);
  assert.deepEqual([tr[0].entryPos, tr[0].exitPos], [2, 5]);
});

test("simulate: segments start flat; an entry that can't fill inside the segment is skipped; an open position is forced out at the last close", () => {
  const cs = candles(10);
  assert.equal(simulate(rules(10, [9], []), cs, 0, 9, H).length, 0, "decided at the last bar: its fill is outside -> no trade");
  const tr = simulate(rules(10, [1], []), cs, 0, 6, H);
  assert.equal(tr[0].forced, true);
  assert.equal(tr[0].exitPos, 7);
  assert.equal(tr[0].exitPrice, cs[6].c);
  assert.equal(tr[0].exitTime, cs[6].t + H);
  assert.equal(simulate(rules(10, [1], [5]), cs, 3, 9, H).length, 0, "the entry at 1 is before the segment: flat at its start");
});

test("fundingSummer: sums rates with time in (t0, t1] — a long pays positive, receives negative", () => {
  const f = fundingSummer([
    { time: 3600, rate: 0.0001 },
    { time: 7200, rate: -0.00005 },
    { time: 10800, rate: 0.0002 },
  ]);
  assert.ok(Math.abs(f(3600, 10800) - 0.00015) < 1e-15, "excludes the payment AT entry, includes the one AT exit");
  assert.ok(Math.abs(f(0, 3600) - 0.0001) < 1e-15);
  assert.equal(f(10800, 99999), 0);
});

test("netReturns: primary 13bps + funding, stress 30bps + funding, sens6 6bps without funding", () => {
  const r = netReturns(0.01, 0.0002);
  assert.ok(Math.abs(r.primary - (0.01 - 0.0013 - 0.0002)) < 1e-15);
  assert.ok(Math.abs(r.stress - (0.01 - 0.003 - 0.0002)) < 1e-15);
  assert.ok(Math.abs(r.sens6 - (0.01 - 0.0006)) < 1e-15);
});

test("profit factor / metrics: no losses = Infinity; no trades = undefined", () => {
  assert.equal(profitFactor({ pos: 1, neg: 0 }), Infinity);
  assert.ok(Number.isNaN(profitFactor({ pos: 0, neg: 0 })));
  const m = metricsOf([0.02, -0.01, 0.03, -0.02]);
  assert.equal(m.trades, 4);
  assert.equal(m.winRate, 0.5);
  assert.ok(Math.abs(m.profitFactor! - 0.05 / 0.03) < 1e-12);
  assert.equal(metricsOf([]).profitFactor, null);
});

test("segments: the last third (by bar count) of the post-warmup window is the holdout", () => {
  assert.deepEqual(segments(200, 499), { train: [200, 399], holdout: [400, 499] });
});

test("randomTrades: same count, same multiset of holding periods, non-overlapping, inside the segment, reproducible", () => {
  const cs = candles(300);
  const holds = [5, 12, 1, 30, 7, 7];
  const a = randomTrades(holds, cs, 50, 249, H, rngFor("seed"));
  const b = randomTrades(holds, cs, 50, 249, H, rngFor("seed"));
  assert.deepEqual(a, b, "seeded -> reproducible");
  assert.equal(a.length, holds.length);
  assert.deepEqual(a.map((t) => t.exitPos - t.entryPos).sort((x, y) => x - y), [...holds].sort((x, y) => x - y));
  const sorted = [...a].sort((x, y) => x.entryPos - y.entryPos);
  for (let i = 0; i < sorted.length; i++) {
    assert.ok(sorted[i].entryPos >= 50 && sorted[i].exitPos <= 250, "inside [from, to + 1]");
    if (i > 0) assert.ok(sorted[i].entryPos >= sorted[i - 1].exitPos, "no overlap");
  }
  // a segment exactly filled by the holds leaves no freedom: always placeable
  const tight = randomTrades([100, 100], cs, 0, 199, H, rngFor("x"));
  assert.equal(tight.length, 2);
});

test("tradeReturns: funding charged over (entry, exit] per cost model", () => {
  const cs = candles(10);
  const [t] = simulate(rules(10, [1], [4]), cs, 0, 9, H);
  const r = tradeReturns([t], fundingSummer([{ time: t.entryTime + 1, rate: 0.001 }]));
  const gross = t.exitPrice / t.entryPrice - 1;
  assert.ok(Math.abs(r.primary[0] - (gross - 0.0013 - 0.001)) < 1e-12);
  assert.ok(Math.abs(r.sens6[0] - (gross - 0.0006)) < 1e-12);
});

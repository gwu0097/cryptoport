import test from "node:test";
import assert from "node:assert/strict";
import { rsi2Rules, bbRules, maRules, donchianRules } from "./rules.ts";
import type { Candle } from "../smc/engine.ts";

const bars = (closes: number[], extra: Partial<Candle> = {}): Candle[] =>
  closes.map((c, i) => ({ t: i * 3600, o: c, h: c + 1, l: c - 1, c, ...extra }));

test("RSI(2): no decision before SMA(200) exists; entry needs close > SMA200 AND RSI2 < 10 on the same bar", () => {
  // 230 rising bars (well above SMA200), then two sharp down bars.
  const closes = [...Array.from({ length: 230 }, (_, i) => 100 + i), 330, 318, 305];
  const r = rsi2Rules(bars(closes));
  assert.equal(r.warmup, 199, "SMA(200) first defined at index 199");
  assert.equal(r.entry.slice(0, 199).some(Boolean), false);
  assert.equal(r.fillOffset, 1);
  const last = closes.length - 1;
  assert.equal(r.entry[last], true, "still above SMA200 after the dip, RSI(2) crushed");
  assert.equal(r.entry[229], false, "RSI(2) = 100 in the uptrend");
});

test("Bollinger: %B <= 0 below the lower band with the trend filter; a flat window has no %B", () => {
  const closes = [...Array.from({ length: 220 }, (_, i) => 100 + i * 0.5), 150];
  const r = bbRules(bars(closes));
  assert.equal(r.entry.at(-1), false, "150 is below SMA200 here -> the trend filter blocks it");
  // 19 closes 301..319 then 280: mean 308.5, sigma ~8.3 -> lower band ~292; 280 is below it, yet above SMA200 (~220).
  const up = [...Array.from({ length: 220 }, (_, i) => 100 + i), 280];
  const r2 = bbRules(bars(up));
  assert.equal(r2.entry.at(-1), true);
  const flat = bbRules(bars(Array.from({ length: 230 }, () => 100)));
  assert.equal(flat.entry.some(Boolean), false, "sigma = 0 -> %B undefined -> never enters");
});

test("MA pullback: the low must touch EMA20 while the close holds above EMA50, in an uptrend", () => {
  const n = 240;
  const closes = Array.from({ length: n }, (_, i) => 100 + i);
  const cs = bars(closes);
  // last bar: close stays high, but its low dips far enough to touch EMA20
  cs[n - 1] = { ...cs[n - 1], l: cs[n - 1].c - 30 };
  const r = maRules(cs);
  assert.equal(r.entry[n - 1], true);
  assert.equal(r.entry[n - 2], false, "low only 1 below the close: no touch");
});

test("Donchian: prior 55-bar high excludes the current bar; exit below the prior 20-bar low", () => {
  const closes = [...Array.from({ length: 60 }, () => 100), 105, 90];
  const cs = bars(closes); // highs = close + 1 = 101 on the flat stretch
  const r = donchianRules(cs);
  assert.equal(r.warmup, 55);
  assert.equal(r.entry[60], true, "105 > prior 55-bar high 101");
  assert.equal(r.exit[61], true, "90 < prior 20-bar low 99");
  assert.equal(r.entry[59], false, "100 is not > 101");
});

test("SMC adapter: flips from the existing engine become entries/exits on the candle the label prints on, filled at that candle's open", async () => {
  const { smcRules } = await import("./rules.ts");
  const { computeSmc } = await import("../smc/engine.ts");
  // 1H candles, alternating trends so the ribbon flips a few times
  const cs: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 600; i++) {
    p *= Math.floor(i / 90) % 2 === 0 ? 1.004 : 0.996;
    cs.push({ t: i * 3600, o: p, h: p * 1.001, l: p * 0.999, c: p * 1.0005 });
  }
  const now = 600 * 3600 + 1;
  const r = smcRules(cs, "1H", now);
  const flips = computeSmc(cs, "1H", now).flips;
  assert.ok(flips.length >= 2, "fixture produces flips");
  assert.equal(r.fillOffset, 0);
  for (const f of flips) {
    const i = cs.findIndex((c) => c.t === f.time);
    assert.equal(f.side === "BUY" ? r.entry[i] : r.exit[i], true);
  }
  assert.equal(r.entry.filter(Boolean).length + r.exit.filter(Boolean).length, flips.length);
});

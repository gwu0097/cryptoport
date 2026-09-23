import test from "node:test";
import assert from "node:assert/strict";
import {
  rsi2EntryTrigger,
  rsi2ExitTrigger,
  bbEntryTrigger,
  bbExitTrigger,
  maExitTrigger,
  donchianEntryTrigger,
  donchianExitTrigger,
  triggerFiresAt,
  type NextTrigger,
} from "./triggers.ts";
import { rsi2Rules, bbRules, maRules, donchianRules, type Rules } from "./rules.ts";
import { rngFor } from "./harness.ts";
import type { Candle } from "../smc/engine.ts";

// The exactness check: append a forming bar that closes a hair either side of
// the trigger and ask the REAL rule (rules.ts) whether it fires on that bar.
const EPS = 1e-6;

function series(seed: string, n: number, drift: number, vol: number): Candle[] {
  const r = rngFor(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p *= 1 + drift + (r() - 0.5) * vol;
    return { t: i * 3600, o: p, h: p * (1 + r() * vol / 2), l: p * (1 - r() * vol / 2), c: p };
  });
}
const withClose = (cs: Candle[], x: number): Candle[] => [...cs, { t: cs.length * 3600, o: x, h: x, l: x, c: x }];

function checkExact(cs: Candle[], trig: NextTrigger | null, rulesOf: (c: Candle[]) => Rules, kind: "entry" | "exit") {
  assert.ok(trig && trig.kind === "price", `expected a price trigger, got ${JSON.stringify(trig)}`);
  const fires = (x: number) => rulesOf(withClose(cs, x))[kind].at(-1)!;
  const d = Math.abs(trig.price) * EPS;
  const inside = trig.condition.includes("below") ? trig.price - d : trig.price + d;
  const outside = trig.condition.includes("below") ? trig.price + d : trig.price - d;
  assert.equal(fires(inside), true, `just inside ${trig.condition} ${trig.price} must fire`);
  assert.equal(fires(outside), false, `just outside ${trig.condition} ${trig.price} must not fire`);
  assert.equal(triggerFiresAt(trig, inside), true);
  if (trig.floor !== null) {
    assert.equal(fires(trig.floor - Math.abs(trig.floor) * EPS), false, "below the SMA(200) floor never fires");
  }
}

test("RSI(2) entry trigger is exact (both Wilder branches), across many random uptrends", () => {
  let checked = 0;
  for (let s = 0; s < 60; s++) {
    const cs = series(`rsi${s}`, 260, 0.002, 0.02);
    const t = rsi2EntryTrigger(cs.map((c) => c.c));
    if (t?.kind !== "price") continue;
    checkExact(cs, t, rsi2Rules, "entry");
    checked++;
  }
  assert.ok(checked >= 20, `enough cases exercised (${checked})`);
});

test("RSI(2) entry: a trigger below the SMA(200) floor is reported as blocked, never as a price", () => {
  const cs = series("down", 260, -0.004, 0.01); // downtrend: close far under SMA200
  const t = rsi2EntryTrigger(cs.map((c) => c.c));
  assert.equal(t?.kind, "blocked");
});

test("RSI(2) exit trigger (close > SMA5) is exact", () => {
  const cs = series("rsiexit", 260, 0.001, 0.02);
  checkExact(cs, rsi2ExitTrigger(cs.map((c) => c.c)), rsi2Rules, "exit");
});

test("Bollinger entry trigger (%B <= 0, quadratic in the close) is exact", () => {
  let checked = 0;
  for (let s = 0; s < 60; s++) {
    const cs = series(`bb${s}`, 260, 0.002, 0.02);
    const t = bbEntryTrigger(cs.map((c) => c.c));
    if (t?.kind !== "price") continue;
    checkExact(cs, t, bbRules, "entry");
    checked++;
  }
  assert.ok(checked >= 20, `enough cases exercised (${checked})`);
});

test("Bollinger exit trigger (close >= middle band) is exact", () => {
  const cs = series("bbexit", 260, 0.001, 0.02);
  checkExact(cs, bbExitTrigger(cs.map((c) => c.c)), bbRules, "exit");
});

test("MA pullback exit trigger (close < EMA50) is exact", () => {
  const cs = series("maexit", 260, 0.001, 0.02);
  checkExact(cs, maExitTrigger(cs.map((c) => c.c)), maRules, "exit");
});

test("Donchian entry/exit triggers (prior 55-high / 20-low) are exact", () => {
  const cs = series("don", 200, 0.001, 0.02);
  checkExact(cs, donchianEntryTrigger(cs.map((c) => c.h)), donchianRules, "entry");
  checkExact(cs, donchianExitTrigger(cs.map((c) => c.l)), donchianRules, "exit");
});

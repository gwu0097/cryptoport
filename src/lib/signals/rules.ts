// Pure rule engines for the Signals page's indicators, one implementation
// shared by the page and the backtest harness (docs/signals/
// PREREG_PULLBACK_INDICATORS.md). Each turns COMPLETED candles into per-bar
// decisions: entry[i] / exit[i] = "the rule fires with information available
// at decision point i", plus fillOffset = where that decision can be executed:
//   1 — indicators 1–4 decide on bar i's CLOSE → fill at the OPEN of bar i+1
//   0 — SMC decides at the END of a completed 3× block, which is the OPEN of
//       the candle its label prints on (bar i) → fill at bar i's open
// Rules/params are fixed by the prereg; do not tune them here.

import { sma, ema, wilderRsi, stdevPop, priorMax, priorMin } from "./ta.ts";
import { computeSmc, type Candle, type ChartTimeframe } from "../smc/engine.ts";

export type IndicatorId = "smc" | "rsi2" | "bb" | "ma" | "donchian";

export interface Rules {
  id: IndicatorId;
  entry: boolean[];
  exit: boolean[];
  fillOffset: 0 | 1;
  /** First bar index at which the rule can be evaluated (all inputs defined). */
  warmup: number;
}

const firstDefined = (...series: (number | null)[][]): number => {
  const n = series[0].length;
  for (let i = 0; i < n; i++) if (series.every((s) => s[i] !== null)) return i;
  return n;
};

export function rsi2Rules(candles: readonly Candle[]): Rules {
  const c = candles.map((x) => x.c);
  const s200 = sma(c, 200);
  const s5 = sma(c, 5);
  const r = wilderRsi(c, 2);
  return {
    id: "rsi2",
    fillOffset: 1,
    warmup: firstDefined(s200, s5, r),
    entry: c.map((x, i) => s200[i] !== null && r[i] !== null && x > s200[i]! && r[i]! < 10),
    exit: c.map((x, i) => s5[i] !== null && x > s5[i]!),
  };
}

export function bbRules(candles: readonly Candle[]): Rules {
  const c = candles.map((x) => x.c);
  const s200 = sma(c, 200);
  const mid = sma(c, 20);
  const sd = stdevPop(c, 20);
  const pctB = c.map((x, i) => {
    if (mid[i] === null || sd[i] === null || sd[i] === 0) return null; // %B undefined on a flat window
    const lower = mid[i]! - 2 * sd[i]!;
    const upper = mid[i]! + 2 * sd[i]!;
    return (x - lower) / (upper - lower);
  });
  return {
    id: "bb",
    fillOffset: 1,
    warmup: firstDefined(s200, mid, sd),
    entry: c.map((x, i) => s200[i] !== null && pctB[i] !== null && x > s200[i]! && pctB[i]! <= 0),
    exit: c.map((x, i) => mid[i] !== null && x >= mid[i]!),
  };
}

export function maRules(candles: readonly Candle[]): Rules {
  const c = candles.map((x) => x.c);
  const s200 = sma(c, 200);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  return {
    id: "ma",
    fillOffset: 1,
    warmup: firstDefined(s200, e20, e50),
    entry: candles.map((k, i) =>
      s200[i] !== null && e20[i] !== null && e50[i] !== null && k.c > s200[i]! && e20[i]! > e50[i]! && k.l <= e20[i]! && k.c > e50[i]!,
    ),
    exit: c.map((x, i) => e50[i] !== null && x < e50[i]!),
  };
}

export function donchianRules(candles: readonly Candle[]): Rules {
  const hi = priorMax(
    candles.map((x) => x.h),
    55,
  );
  const lo = priorMin(
    candles.map((x) => x.l),
    20,
  );
  return {
    id: "donchian",
    fillOffset: 1,
    warmup: firstDefined(hi, lo),
    entry: candles.map((k, i) => hi[i] !== null && k.c > hi[i]!),
    exit: candles.map((k, i) => lo[i] !== null && k.c < lo[i]!),
  };
}

/** SMC v4.2 through its existing engine (engine.ts, unchanged): a BUY flip at
 * candle i opens, a SELL flip closes; both known at candle i's open. */
export function smcRules(candles: readonly Candle[], tf: ChartTimeframe, nowSec: number): Rules {
  const { ribbon, flips } = computeSmc(candles, tf, nowSec);
  const indexOf = new Map(candles.map((k, i) => [k.t, i]));
  const entry = candles.map(() => false);
  const exit = candles.map(() => false);
  for (const f of flips) {
    const i = indexOf.get(f.time);
    if (i === undefined) continue;
    if (f.side === "BUY") entry[i] = true;
    else exit[i] = true;
  }
  return { id: "smc", fillOffset: 0, warmup: ribbon.length ? (indexOf.get(ribbon[0].time) ?? candles.length) : candles.length, entry, exit };
}

export function rulesFor(id: IndicatorId, candles: readonly Candle[], tf: ChartTimeframe, nowSec: number): Rules {
  switch (id) {
    case "smc":
      return smcRules(candles, tf, nowSec);
    case "rsi2":
      return rsi2Rules(candles);
    case "bb":
      return bbRules(candles);
    case "ma":
      return maRules(candles);
    case "donchian":
      return donchianRules(candles);
  }
}

// What the Signals page shows for one indicator on one token — state, signal
// history, the exact next-bar trigger, chart overlays — built from the SAME
// rule engines (rules.ts) and the SAME position state machine (harness.ts's
// simulate) the deferred backtest uses, so the page can never drift from
// what would be tested. Pure; see view.test.ts.

import { sma, ema, wilderRsi, stdevPop, priorMax, priorMin, type Series } from "./ta.ts";
import { rulesFor, type IndicatorId } from "./rules.ts";
import { simulate } from "./harness.ts";
import {
  rsi2EntryTrigger,
  rsi2ExitTrigger,
  bbEntryTrigger,
  bbExitTrigger,
  maEntryTrigger,
  maExitTrigger,
  donchianEntryTrigger,
  donchianExitTrigger,
  type NextTrigger,
  type TriggerSide,
} from "./triggers.ts";
import { computeSmc, TIMEFRAMES, type Candle, type ChartTimeframe } from "../smc/engine.ts";

export interface SignalMark {
  side: TriggerSide;
  /** The chart candle the marker sits on. */
  barTime: number;
  /** When the signal was decided: the close of `barTime`'s candle for the
   * bar-close indicators; the label candle's open for SMC. */
  time: number;
  price: number;
}

export interface OverlayLine {
  title: string;
  color: string;
  style: "solid" | "dotted" | "dashed";
  /** Step line (SMC's ribbon only changes when a block completes). */
  step: boolean;
  points: { time: number; value: number; color?: string }[];
}

export interface IndicatorView {
  /** null = not enough real venue history to evaluate the rule yet. */
  state: { up: boolean; label: "Bull" | "Bear" | "Long" | "Flat" } | null;
  signals: SignalMark[];
  trigger: NextTrigger | null;
  /** When the forming bar/block closes and decides the trigger. */
  decidedAt: number | null;
  /** "1H bar" / "3H block" — what has to close past the trigger. */
  closeUnit: string;
  /** Current indicator values (last completed bar), labeled. */
  readout: { label: string; value: number | null }[];
  overlays: OverlayLine[];
  /** Completed candles with real venue trades the rule ran on (after dropping
   * Hyperliquid's leading n = 0 imported run); for "not enough history". */
  venueBars: number;
}

export const BULL = "#26a65b";
export const BEAR = "#e05a4f";
const C_TREND = "#a78bfa"; // SMA(200) trend filter
const C_FAST = "#38bdf8";
const C_SLOW = "#f59e0b";

/** Drop Hyperliquid's leading pre-launch run of n = 0 candles (imported
 * history, not venue trades — prereg Amendment 2). Genuine mid-series
 * no-trade candles stay. Candles without `n` (tests) are kept as-is. */
export function dropImportedRun(candles: readonly Candle[]): Candle[] {
  if (!candles.some((c) => c.n !== undefined)) return [...candles];
  const first = candles.findIndex((c) => (c.n ?? 0) > 0);
  return first === -1 ? [] : candles.slice(first);
}

function line(title: string, color: string, times: readonly number[], values: Series, style: OverlayLine["style"] = "solid"): OverlayLine {
  const points = values.flatMap((v, i) => (v === null ? [] : [{ time: times[i], value: v }]));
  return { title, color, style, step: false, points };
}

function overlaysFor(id: Exclude<IndicatorId, "smc">, completed: readonly Candle[]) {
  const t = completed.map((c) => c.t);
  const c = completed.map((k) => k.c);
  const last = (s: Series) => s.at(-1) ?? null;
  switch (id) {
    case "rsi2": {
      const s200 = sma(c, 200);
      const s5 = sma(c, 5);
      return {
        overlays: [line("SMA(200)", C_TREND, t, s200), line("SMA(5)", C_FAST, t, s5, "dotted")],
        readout: [
          { label: "RSI(2)", value: last(wilderRsi(c, 2)) },
          { label: "SMA(5)", value: last(s5) },
          { label: "SMA(200)", value: last(s200) },
        ],
      };
    }
    case "bb": {
      const s200 = sma(c, 200);
      const mid = sma(c, 20);
      const sd = stdevPop(c, 20);
      const band = (k: number) => mid.map((m, i) => (m === null || sd[i] === null ? null : m + k * sd[i]!));
      const upper = band(2);
      const lower = band(-2);
      const i = c.length - 1;
      const pctB = i >= 0 && upper[i] !== null && lower[i] !== null && upper[i]! > lower[i]! ? (c[i] - lower[i]!) / (upper[i]! - lower[i]!) : null;
      return {
        overlays: [
          line("SMA(200)", C_TREND, t, s200),
          line("Upper", C_FAST, t, upper, "dotted"),
          line("Middle", C_FAST, t, mid),
          line("Lower", C_FAST, t, lower, "dotted"),
        ],
        readout: [
          { label: "%B", value: pctB },
          { label: "Lower band", value: last(lower) },
          { label: "Middle", value: last(mid) },
          { label: "SMA(200)", value: last(s200) },
        ],
      };
    }
    case "ma": {
      const s200 = sma(c, 200);
      const e20 = ema(c, 20);
      const e50 = ema(c, 50);
      return {
        overlays: [line("SMA(200)", C_TREND, t, s200), line("EMA(20)", C_FAST, t, e20), line("EMA(50)", C_SLOW, t, e50)],
        readout: [
          { label: "EMA(20)", value: last(e20) },
          { label: "EMA(50)", value: last(e50) },
          { label: "SMA(200)", value: last(s200) },
        ],
      };
    }
    case "donchian": {
      // Drawn at bar i = the channel that bar i's close was compared against.
      const hi = priorMax(
        completed.map((k) => k.h),
        55,
      );
      const lo = priorMin(
        completed.map((k) => k.l),
        20,
      );
      return {
        overlays: [line("Prior 55-bar high", C_FAST, t, hi), line("Prior 20-bar low", C_SLOW, t, lo, "dotted")],
        readout: [
          { label: "55-bar high", value: completed.length >= 55 ? Math.max(...completed.slice(-55).map((k) => k.h)) : null },
          { label: "20-bar low", value: completed.length >= 20 ? Math.min(...completed.slice(-20).map((k) => k.l)) : null },
        ],
      };
    }
  }
}

function triggerFor(id: Exclude<IndicatorId, "smc">, long: boolean, completed: readonly Candle[], fmt: (n: number) => string): NextTrigger | null {
  const c = completed.map((k) => k.c);
  switch (id) {
    case "rsi2":
      return long ? rsi2ExitTrigger(c) : rsi2EntryTrigger(c);
    case "bb":
      return long ? bbExitTrigger(c) : bbEntryTrigger(c);
    case "ma":
      return long ? maExitTrigger(c) : maEntryTrigger(c, fmt);
    case "donchian":
      return long ? donchianExitTrigger(completed.map((k) => k.l)) : donchianEntryTrigger(completed.map((k) => k.h));
  }
}

/** A bar-close indicator (RSI(2), Bollinger, MA pullback, Donchian): decided on
 * each COMPLETED bar's close; the forming bar is never evaluated. Long-only: Long after a Buy, Flat after a Sell. */
export function barCloseView(
  id: Exclude<IndicatorId, "smc">,
  candles: readonly Candle[],
  tf: ChartTimeframe,
  nowSec: number,
  fmt: (n: number) => string,
): IndicatorView {
  const barSeconds = TIMEFRAMES[tf].candleSeconds;
  const completed = dropImportedRun(candles).filter((c) => c.t + barSeconds <= nowSec);
  const { overlays, readout } = overlaysFor(id, completed);
  const base = { closeUnit: `${tf} bar`, overlays, readout, venueBars: completed.length, decidedAt: (Math.floor(nowSec / barSeconds) + 1) * barSeconds };
  const rules = rulesFor(id, completed, tf, nowSec);
  if (rules.warmup >= completed.length) return { ...base, state: null, signals: [], trigger: null };

  // simulate() needs a candle to fill into after the last completed bar, so a
  // signal decided on that bar isn't dropped; only positions are read here,
  // never prices, so a placeholder (no rule is evaluated on it) is enough.
  const last = completed[completed.length - 1];
  const withSlot = [...completed, { t: last.t + barSeconds, o: last.c, h: last.c, l: last.c, c: last.c }];
  const trades = simulate(rules, withSlot, rules.warmup, completed.length, barSeconds);
  const mark = (side: TriggerSide, fillPos: number): SignalMark => {
    const k = completed[fillPos - rules.fillOffset];
    return { side, barTime: k.t, time: k.t + barSeconds, price: k.c };
  };
  const signals = trades.flatMap((tr) => (tr.forced ? [mark("BUY", tr.entryPos)] : [mark("BUY", tr.entryPos), mark("SELL", tr.exitPos)]));
  // A forced trade is only ever the one still open at the end (every exit
  // decided on a completed bar fills into the slot or earlier).
  const long = trades.at(-1)?.forced === true;
  return {
    ...base,
    state: long ? { up: true, label: "Long" } : { up: false, label: "Flat" },
    signals,
    trigger: triggerFor(id, long, completed, fmt),
  };
}

/** SMC v4.2 through its own engine (unchanged), mapped onto the shared view. */
export function smcView(candles: readonly Candle[], tf: ChartTimeframe, nowSec: number): IndicatorView {
  const { ribbon, flips, state, trigger, completedBlocks } = computeSmc(candles, tf, nowSec);
  const color = (bull: boolean) => (bull ? BULL : BEAR);
  const last = ribbon.at(-1);
  return {
    state: state ? { up: state.bull, label: state.bull ? "Bull" : "Bear" } : null,
    signals: flips.map((f) => ({ side: f.side, barTime: f.time, time: f.time, price: f.price })),
    trigger: trigger ? { kind: "price", side: trigger.flipTo, condition: trigger.flipIfClose, price: trigger.price, floor: null } : null,
    decidedAt: trigger?.formingBlockEnd ?? null,
    closeUnit: `${TIMEFRAMES[tf].blockLabel} block`,
    readout: [
      { label: "Close Series", value: last?.close ?? null },
      { label: "Open Series", value: last?.open ?? null },
    ],
    overlays: [
      { title: "Close Series", color: BULL, style: "solid", step: true, points: ribbon.map((p) => ({ time: p.time, value: p.close, color: color(p.bull) })) },
      { title: "Open Series", color: BULL, style: "dotted", step: true, points: ribbon.map((p) => ({ time: p.time, value: p.open, color: color(p.bull) })) },
    ],
    venueBars: completedBlocks,
  };
}

export function viewFor(id: IndicatorId, candles: readonly Candle[], tf: ChartTimeframe, nowSec: number, fmt: (n: number) => string): IndicatorView {
  return id === "smc" ? smcView(candles, tf, nowSec) : barCloseView(id, candles, tf, nowSec, fmt);
}

// Exact next-bar triggers for the pullback/trend indicators — see
// triggers.test.ts, which checks each one against rules.ts by appending a
// candle just either side of the returned price. docs/signals/
// PREREG_PULLBACK_INDICATORS.md §7: a trigger price is shown ONLY when it's
// exactly computable; otherwise the current indicator values are shown,
// never an approximation presented as exact.
//
// Every trigger is "the price the FORMING bar must close at", given all
// completed bars fixed. `closes`/`highs`/`lows` are COMPLETED bars only.

import { ema, wilderAverages } from "./ta.ts";

export type TriggerSide = "BUY" | "SELL";

export type NextTrigger =
  | {
      kind: "price";
      side: TriggerSide;
      /** The forming bar's close must be ___ `price` for the rule to fire. */
      condition: "above" | "below" | "at or above" | "at or below";
      price: number;
      /** A second bound that must ALSO hold (the SMA(200) trend filter at the same close). */
      floor: number | null;
    }
  /** No close can fire the rule this bar: it needs a close under `price`, but
   * the SMA(200) filter needs one above `floor` ≥ `price`. */
  | { kind: "blocked"; side: TriggerSide; price: number; floor: number }
  | { kind: "value"; side: TriggerSide; text: string }; // not exactly computable: current values instead

const sumLast = (xs: readonly number[], k: number) => xs.slice(-k).reduce((a, b) => a + b, 0);

/** The SMA(200) filter at the forming bar includes its own close x:
 * x > (S199 + x)/200 ⇔ x > S199/199. */
function sma200Floor(closes: readonly number[]): number | null {
  return closes.length >= 199 ? sumLast(closes, 199) / 199 : null;
}

function withFloor(side: TriggerSide, condition: "below" | "at or below", price: number, floor: number): NextTrigger {
  return floor >= price
    ? { kind: "blocked", side, price, floor }
    : { kind: "price", side, condition, price, floor };
}

/** RSI(2) entry: Wilder RSI(2) < 10 and close > SMA(200) on the same close.
 * With p = last close and U, D the last Wilder averages (n = 2):
 *   U' = (U + max(x−p, 0))/2,  D' = (D + max(p−x, 0))/2,  RSI < 10 ⇔ 9U' < D'
 * RSI falls monotonically as x falls, so the setup is x < x*, where
 *   x* = p + (D − 9U)/9   if D > 9U   (the root lies above p)
 *   x* = p + D − 9U        otherwise   (the root lies at or below p). */
export function rsi2EntryTrigger(closes: readonly number[]): NextTrigger | null {
  const { up, down } = wilderAverages(closes, 2);
  const U = up.at(-1);
  const D = down.at(-1);
  const floor = sma200Floor(closes);
  if (U == null || D == null || floor === null) return null;
  const p = closes[closes.length - 1];
  const xStar = D > 9 * U ? p + (D - 9 * U) / 9 : p + D - 9 * U;
  return withFloor("BUY", "below", xStar, floor);
}

/** RSI(2) exit: close > SMA(5) at the same close ⇔ x > S4/4. */
export function rsi2ExitTrigger(closes: readonly number[]): NextTrigger | null {
  if (closes.length < 4) return null;
  return { kind: "price", side: "SELL", condition: "above", price: sumLast(closes, 4) / 4, floor: null };
}

/** Bollinger entry: %B ≤ 0 on BB(20, 2) and close > SMA(200). With a = S19,
 * q = sum of squares of the last 19 closes, the band condition x ≤ m − 2σ
 * (m, σ over the 19 closes + x, population σ) reduces to
 *   x ≤ a/19  and  57x² − 6ax + a² − 16q ≥ 0,
 * and since a/19 lies between the quadratic's roots, the solution is
 * x ≤ r₁ = (6a − √(192(19q − a²)))/114. */
export function bbEntryTrigger(closes: readonly number[]): NextTrigger | null {
  const floor = sma200Floor(closes);
  if (closes.length < 19 || floor === null) return null;
  const last19 = closes.slice(-19);
  const a = last19.reduce((s, v) => s + v, 0);
  const q = last19.reduce((s, v) => s + v * v, 0);
  const disc = Math.max(0, 192 * (19 * q - a * a)); // ≥ 0 by Cauchy–Schwarz; clamp float noise
  const r1 = (6 * a - Math.sqrt(disc)) / 114;
  return withFloor("BUY", "at or below", r1, floor);
}

/** Bollinger exit: close ≥ middle band (SMA(20) incl. x) ⇔ x ≥ S19/19. */
export function bbExitTrigger(closes: readonly number[]): NextTrigger | null {
  if (closes.length < 19) return null;
  return { kind: "price", side: "SELL", condition: "at or above", price: sumLast(closes, 19) / 19, floor: null };
}

/** MA pullback entry depends on the forming bar's LOW and CLOSE together
 * (low ≤ EMA20(x) while x > EMA50(x), plus the trend filters), so no single
 * trigger price exists. The current values are shown instead, labeled. */
export function maEntryTrigger(closes: readonly number[], fmt: (n: number) => string): NextTrigger | null {
  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  if (e20 == null || e50 == null) return null;
  return {
    kind: "value",
    side: "BUY",
    text: `low must touch EMA(20) ≈ ${fmt(e20)} while closing above EMA(50) ≈ ${fmt(e50)} (both move with this bar's close; also needs close > SMA(200) and EMA(20) > EMA(50))`,
  };
}

/** MA pullback exit: close < EMA(50) at the same close. EMA50' = αx + (1−α)E,
 * so x < αx + (1−α)E ⇔ x < E, the last completed EMA(50). */
export function maExitTrigger(closes: readonly number[]): NextTrigger | null {
  const e50 = ema(closes, 50).at(-1);
  if (e50 == null) return null;
  return { kind: "price", side: "SELL", condition: "below", price: e50, floor: null };
}

/** Donchian entry: close > the prior 55-bar high (the last 55 completed bars). */
export function donchianEntryTrigger(highs: readonly number[]): NextTrigger | null {
  if (highs.length < 55) return null;
  return { kind: "price", side: "BUY", condition: "above", price: Math.max(...highs.slice(-55)), floor: null };
}

/** Donchian exit: close < the prior 20-bar low (the last 20 completed bars). */
export function donchianExitTrigger(lows: readonly number[]): NextTrigger | null {
  if (lows.length < 20) return null;
  return { kind: "price", side: "SELL", condition: "below", price: Math.min(...lows.slice(-20)), floor: null };
}

/** Does a close at `price` satisfy the trigger (both bounds)? For the "fires
 * at the current price" badge. */
export function triggerFiresAt(t: NextTrigger, price: number): boolean {
  if (t.kind !== "price") return false;
  const main =
    t.condition === "above" ? price > t.price : t.condition === "below" ? price < t.price : t.condition === "at or above" ? price >= t.price : price <= t.price;
  return main && (t.floor === null || price > t.floor);
}

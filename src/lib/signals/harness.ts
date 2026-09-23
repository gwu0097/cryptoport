// Pure backtest harness for the Signals page's indicators — the ONE harness
// all five indicators run through (docs/signals/PREREG_PULLBACK_INDICATORS.md
// §4 + Amendment 1). See harness.test.ts. No I/O: candles, rules and funding
// rows are passed in.

import type { Candle } from "../smc/engine.ts";
import type { Rules } from "./rules.ts";

export interface Trade {
  entryPos: number; // candle index whose OPEN is the entry fill
  exitPos: number; // candle index whose OPEN is the exit fill; = segment end + 1 for a forced exit
  entryPrice: number;
  exitPrice: number;
  entryTime: number; // unix seconds
  exitTime: number;
  forced: boolean; // closed at the segment's last completed close
}

/** Cost models (Amendment 1): primary decides verdicts; stress flags cost-sensitivity; sens6 is the spec comparison only. */
export const COST_MODELS = [
  { id: "primary", roundTrip: 0.0013, funding: true }, // 4.5 bps taker + 2 bps slippage, per side
  { id: "stress", roundTrip: 0.003, funding: true },
  { id: "sens6", roundTrip: 0.0006, funding: false },
] as const;
export type CostModelId = (typeof COST_MODELS)[number]["id"];

/** Run the rules as a long-only state machine over decision bars [from, to],
 * flat at `from` (segments are independent). A decision at bar i fills at
 * the open of bar i + fillOffset; a fill that would land past `to` can't
 * happen inside the segment — an entry is skipped, an exit becomes a forced
 * exit at bar `to`'s close. A position still open at the end is forced out. */
export function simulate(rules: Rules, candles: readonly Candle[], from: number, to: number, barSeconds: number): Trade[] {
  const trades: Trade[] = [];
  let open: { pos: number; decision: number } | null = null;
  const forcedExit = (entry: { pos: number }): Trade => ({
    entryPos: entry.pos,
    exitPos: to + 1,
    entryPrice: candles[entry.pos].o,
    exitPrice: candles[to].c,
    entryTime: candles[entry.pos].t,
    exitTime: candles[to].t + barSeconds,
    forced: true,
  });
  for (let i = Math.max(from, rules.warmup); i <= to; i++) {
    const fill = i + rules.fillOffset;
    if (open === null) {
      if (rules.entry[i] && fill <= to) open = { pos: fill, decision: i };
    } else if (rules.exit[i] && i > open.decision) {
      if (fill <= to) {
        trades.push({
          entryPos: open.pos,
          exitPos: fill,
          entryPrice: candles[open.pos].o,
          exitPrice: candles[fill].o,
          entryTime: candles[open.pos].t,
          exitTime: candles[fill].t,
          forced: false,
        });
      } else {
        trades.push(forcedExit(open));
      }
      open = null;
    }
  }
  if (open !== null) trades.push(forcedExit(open));
  return trades;
}

/** Sum of hourly funding rates with time in (t0, t1] — a long pays a positive
 * rate and receives a negative one (Amendment 1: actual funding). Built once
 * per token: sorted times + prefix sums, O(log n) per lookup. */
export function fundingSummer(rows: readonly { time: number; rate: number }[]): (t0: number, t1: number) => number {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const times = sorted.map((r) => r.time);
  const prefix = [0];
  for (const r of sorted) prefix.push(prefix[prefix.length - 1] + r.rate);
  const upperBound = (t: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo; // count of times <= t
  };
  return (t0, t1) => prefix[upperBound(t1)] - prefix[upperBound(t0)];
}

/** Net return per cost model: exit/entry − 1 − round-trip cost − Σ funding (constant notional). */
export function netReturns(gross: number, funding: number): Record<CostModelId, number> {
  const out = {} as Record<CostModelId, number>;
  for (const m of COST_MODELS) out[m.id] = gross - m.roundTrip - (m.funding ? funding : 0);
  return out;
}

export interface Sums {
  pos: number; // Σ positive net returns
  neg: number; // Σ |negative net returns|
}

/** Profit factor from sums: Infinity with no losing trades (and ≥1 win), NaN with no trades or no P&L. */
export function profitFactor(s: Sums): number {
  if (s.neg === 0) return s.pos > 0 ? Infinity : NaN;
  return s.pos / s.neg;
}

export interface Metrics {
  trades: number;
  winRate: number | null;
  profitFactor: number | null; // null = undefined (no trades); Infinity serialized by the caller
  meanReturn: number | null;
}

export function metricsOf(returns: readonly number[]): Metrics & { sums: Sums } {
  const sums = { pos: 0, neg: 0 };
  let wins = 0;
  for (const r of returns) {
    if (r > 0) {
      sums.pos += r;
      wins++;
    } else sums.neg += -r;
  }
  const n = returns.length;
  const pf = profitFactor(sums);
  return {
    trades: n,
    winRate: n ? wins / n : null,
    profitFactor: Number.isNaN(pf) ? null : pf,
    meanReturn: n ? returns.reduce((a, b) => a + b, 0) / n : null,
    sums,
  };
}

/** Held-back third (prereg §4): the tradable window [warmup, last] split by
 * bar count; training = first two-thirds, holdout = last third. */
export function segments(warmup: number, lastIndex: number): { train: [number, number]; holdout: [number, number] } | null {
  const len = lastIndex - warmup + 1;
  if (len < 3) return null;
  const cut = warmup + Math.floor((2 * len) / 3);
  return { train: [warmup, cut - 1], holdout: [cut, lastIndex] };
}

/** Deterministic PRNG (mulberry32) seeded from a string, so a run is reproducible. */
export function rngFor(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random-entry trial (prereg §4): the same number of trades, holding
 * periods drawn without replacement from the indicator's own (a random
 * permutation of them), placed non-overlapping and uniformly at random in
 * [from, to] via a random composition of the free bars — every
 * non-overlapping arrangement is equally likely and placement never fails.
 * A trade occupies fill positions [e, e + h); e + h = to + 1 is a forced
 * close at bar `to`'s close, same as the indicator's own forced exits. */
export function randomTrades(
  holds: readonly number[],
  candles: readonly Candle[],
  from: number,
  to: number,
  barSeconds: number,
  rand: () => number,
): Trade[] {
  const k = holds.length;
  const order = [...holds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const slots = to - from + 1;
  const free = slots - order.reduce((a, b) => a + b, 0);
  if (free < 0) throw new Error("holding periods exceed the segment");
  // k distinct sorted positions from {0 .. free + k - 1} (Floyd's algorithm), then
  // start_j = from + (p_j - j) + Σ_{m<j} h_m.
  const chosen = new Set<number>();
  const universe = free + k;
  for (let j = universe - k; j < universe; j++) {
    const t = Math.floor(rand() * (j + 1));
    chosen.add(chosen.has(t) ? j : t);
  }
  const p = [...chosen].sort((a, b) => a - b);
  const trades: Trade[] = [];
  let used = 0;
  for (let j = 0; j < k; j++) {
    const e = from + (p[j] - j) + used;
    const x = e + order[j];
    used += order[j];
    const forced = x === to + 1;
    trades.push({
      entryPos: e,
      exitPos: x,
      entryPrice: candles[e].o,
      exitPrice: forced ? candles[to].c : candles[x].o,
      entryTime: candles[e].t,
      exitTime: forced ? candles[to].t + barSeconds : candles[x].t,
      forced,
    });
  }
  return trades;
}

/** Per-trade net returns per cost model. */
export function tradeReturns(trades: readonly Trade[], funding: (t0: number, t1: number) => number): Record<CostModelId, number[]> {
  const out = Object.fromEntries(COST_MODELS.map((m) => [m.id, [] as number[]])) as Record<CostModelId, number[]>;
  for (const t of trades) {
    const nr = netReturns(t.exitPrice / t.entryPrice - 1, funding(t.entryTime, t.exitTime));
    for (const m of COST_MODELS) out[m.id].push(nr[m.id]);
  }
  return out;
}

export function sumsOf(returns: readonly number[]): Sums {
  const s = { pos: 0, neg: 0 };
  for (const r of returns) {
    if (r > 0) s.pos += r;
    else s.neg += -r;
  }
  return s;
}

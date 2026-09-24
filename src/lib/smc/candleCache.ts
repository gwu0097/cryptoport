// Completed-candle cache logic for the Signals page — see candleCache.test.ts.
// The indicators only ever read COMPLETED candles, and a completed candle
// never changes, so caching them is exact, not an approximation. An entry is
// reused until the next bar closes; after that only the new candles are
// fetched (candleSnapshot takes a startTime), from the last completed candle
// on (re-fetching it in case it closed moments before the previous fetch and
// wasn't final yet). Pure: the store and the network calls live in
// signals.ts / hyperliquid.ts.

import type { Candle } from "./engine.ts";

/** A candle only counts as final this long after its close — Hyperliquid may
 * still be aggregating its last trades right at the boundary. */
export const SETTLE_SEC = 15;

export interface CandleEntry {
  barSeconds: number;
  /** Completed candles, ascending, deduped by open time. */
  completed: Candle[];
  /** The candle forming at fetch time: its OPEN is fixed for the whole bar
   * (SMC's trigger needs it); its high/low/close are as of `fetchedAtSec`. */
  forming: Candle | null;
  /** The window start this entry covers (a young perp may have no candles that far back). */
  coverFromSec: number;
  fetchedAtSec: number;
}

export type FetchPlan = { kind: "hit" } | { kind: "incremental"; fromSec: number } | { kind: "full"; fromSec: number };

export const barOpenSec = (nowSec: number, barSeconds: number) => Math.floor(nowSec / barSeconds) * barSeconds;

/** Still exact at `nowSec`: no bar has closed since the fetch, and the fetch
 * came late enough in its bar for the previous candle to be final. */
export function isFresh(e: CandleEntry, nowSec: number): boolean {
  const open = barOpenSec(e.fetchedAtSec, e.barSeconds);
  return barOpenSec(nowSec, e.barSeconds) === open && e.fetchedAtSec >= open + SETTLE_SEC;
}

export function planFetch(e: CandleEntry | undefined, wantFromSec: number, nowSec: number): FetchPlan {
  if (!e || e.coverFromSec > wantFromSec) return { kind: "full", fromSec: wantFromSec };
  if (isFresh(e, nowSec)) return { kind: "hit" };
  const last = e.completed.at(-1);
  return { kind: "incremental", fromSec: last ? last.t : e.coverFromSec };
}

/** Fold a fetch (every candle from `plan.fromSec` to now, forming one included) into the entry. */
export function applyFetch(
  e: CandleEntry | undefined,
  plan: Exclude<FetchPlan, { kind: "hit" }>,
  fetched: readonly Candle[],
  barSeconds: number,
  nowSec: number,
): CandleEntry {
  const fresh = fetched.filter((c) => c.t + barSeconds <= nowSec);
  const kept = plan.kind === "incremental" && e ? e.completed.filter((c) => c.t < plan.fromSec) : [];
  const byT = new Map<number, Candle>();
  for (const c of [...kept, ...fresh]) byT.set(c.t, c);
  const open = barOpenSec(nowSec, barSeconds);
  return {
    barSeconds,
    completed: [...byT.values()].sort((a, b) => a.t - b.t),
    forming: fetched.find((c) => c.t === open) ?? null,
    coverFromSec: plan.kind === "full" ? plan.fromSec : e!.coverFromSec,
    fetchedAtSec: nowSec,
  };
}

/** The candles a caller asked for: completed ones from `wantFromSec`, then the forming one. */
export function candlesFrom(e: CandleEntry, wantFromSec: number): Candle[] {
  const completed = e.completed.filter((c) => c.t >= wantFromSec);
  return e.forming ? [...completed, e.forming] : completed;
}

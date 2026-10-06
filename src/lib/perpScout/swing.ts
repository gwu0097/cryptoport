// How a trader trades, from their latest fills (pure): how often they adjust
// positions and how long a position lasts. Perp Scout follows swing traders
// (owner 2026-10-06: "adjusting positions 2-3 times a week or more, not
// holding a super long book"), so the screen needs both — a slow book and a
// bot both look profitable on a PnL curve.

import type { Fill } from "./entries.ts";

const DAY_MS = 24 * 60 * 60_000;

export interface SwingStats {
  /** Days the measures cover: the last 30, or less when the fills read
   * (Hyperliquid's latest 2,000) don't reach back that far. */
  windowDays: number;
  /** Distinct orders a week in the window: each order that filled, in one
   * or many pieces, is one adjustment. */
  ordersPerWeek: number;
  /** Days a week with at least one fill. */
  activeDaysPerWeek: number;
  /** Positions closed in the window that were also opened in it. */
  closedTrades: number;
  /** Median hours from opening to closing those; null without any. */
  medianHoldHours: number | null;
}

/** Swing figures over the last `days` (30) of `fills`. `fills` may be in any
 * order. With no fills in the window: zero activity, no hold time. */
export function swingStats(fills: readonly Fill[], nowMs: number, days = 30): SwingStats {
  const oldest = fills.reduce((m, f) => Math.min(m, f.time), Infinity);
  const from = Math.max(nowMs - days * DAY_MS, Number.isFinite(oldest) ? oldest : nowMs);
  const windowDays = Math.max((nowMs - from) / DAY_MS, 1);
  const inWindow = fills.filter((f) => f.time >= from).sort((a, b) => a.time - b.time);
  const orders = new Set(inWindow.map((f) => (f.oid !== null ? `o${f.oid}` : `t${f.coin}:${f.time}`)));
  const activeDays = new Set(inWindow.map((f) => Math.floor(f.time / DAY_MS)));
  // Round trips per coin: opened from flat (or flipped) to back to flat.
  const openedAt = new Map<string, number>();
  const holds: number[] = [];
  for (const f of inWindow) {
    const after = f.startPosition + (f.side === "B" ? f.sz : -f.sz);
    const flat = (x: number) => Math.abs(x) <= 1e-9 * Math.max(1, f.sz);
    const wasFlat = flat(f.startPosition);
    const flipped = !wasFlat && !flat(after) && Math.sign(after) !== Math.sign(f.startPosition);
    if (!wasFlat && (flat(after) || flipped) && openedAt.has(f.coin)) {
      holds.push(f.time - openedAt.get(f.coin)!);
      openedAt.delete(f.coin);
    }
    if ((wasFlat || flipped) && !flat(after)) openedAt.set(f.coin, f.time);
  }
  holds.sort((a, b) => a - b);
  const mid = Math.floor(holds.length / 2);
  const median = holds.length === 0 ? null : holds.length % 2 ? holds[mid] : (holds[mid - 1] + holds[mid]) / 2;
  return {
    windowDays,
    ordersPerWeek: (orders.size / windowDays) * 7,
    activeDaysPerWeek: (activeDays.size / windowDays) * 7,
    closedTrades: holds.length,
    medianHoldHours: median === null ? null : median / 3_600_000,
  };
}

export const SWING = {
  /** Adjusts at least this often (owner: "2-3 times a week or more"). */
  minOrdersPerWeek: 2,
  /** More than this is a bot or a scalper, too fast to follow at a lag. */
  maxOrdersPerWeek: 150,
  /** A typical position lasts this long: hours to days, not minutes or months. */
  minHoldHours: 2,
  maxHoldHours: 21 * 24,
} as const;

/** Why a trader isn't a swing trader, or [] when they are. A trader with no
 * position both opened and closed in the window has no hold time to judge,
 * which fails it: nothing shows they close positions. */
export function swingFailures(s: SwingStats): string[] {
  const why: string[] = [];
  if (s.ordersPerWeek < SWING.minOrdersPerWeek) why.push(`${s.ordersPerWeek.toFixed(1)} orders a week`);
  if (s.ordersPerWeek > SWING.maxOrdersPerWeek) why.push(`${Math.round(s.ordersPerWeek)} orders a week (too fast)`);
  if (s.medianHoldHours === null) why.push("no position opened and closed in the window");
  else if (s.medianHoldHours < SWING.minHoldHours) why.push(`holds ${Math.round(s.medianHoldHours * 60)} min`);
  else if (s.medianHoldHours > SWING.maxHoldHours) why.push(`holds ${Math.round(s.medianHoldHours / 24)} days`);
  return why;
}

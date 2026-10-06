// Trades the user marked to follow in Perp Scout (owner 2026-10-06: "if I
// want to track a specific trade, I mark it, and a table underneath lists
// the trades I care about — open, closed or stopped"). Pure: what a tracked
// trade is, and its status now from the latest scan.

import { liveFigures, moveInFavour, latestMove, type MoveKind, type ScoutEntry } from "./entries.ts";
import type { ScoutClose } from "./closes.ts";

export const MAX_TRACKED = 50;

/** One marked trade: a trader's position in a coin on a side, as it was when
 * marked. `openedAt` tells this position from a later one in the same coin
 * (null = opened before the fills read). */
export interface TrackedTrade {
  address: string;
  coin: string;
  side: "long" | "short";
  openedAt: number | null;
  /** When the user marked it (ms). */
  trackedAt: number;
  /** As it was when marked. */
  at: {
    entryPx: number | null;
    /** The price then: the mark for an open position, the exit for a closed one. */
    price: number | null;
    size: number | null;
    leverage: number | null;
    tp: number | null;
    sl: number | null;
  };
}

export const trackedKey = (t: Pick<TrackedTrade, "address" | "coin" | "side" | "openedAt">) => `${t.address}:${t.coin}:${t.side}:${t.openedAt ?? "before"}`;

export type TrackedStatus =
  | { kind: "open"; move: { kind: MoveKind; at: number } | null; entry: ScoutEntry }
  | { kind: "closed" | "stopped" | "target"; close: ScoutClose }
  /** Not open now and no close seen in the window: it was closed longer ago
   * than the closes kept, or the trader wasn't read. */
  | { kind: "gone" };

export interface TrackedView {
  trade: TrackedTrade;
  status: TrackedStatus;
  /** The price now: the mark while open, the exit once closed. */
  price: number | null;
  /** Their entry now (moves when they add), else as marked. */
  entryPx: number | null;
  /** Move since their entry, in their direction (the return once closed). */
  vsEntry: number | null;
  /** Move since the user marked it, in their direction: what a copy made
   * then would show (at 1×). */
  sinceTracked: number | null;
  pnlUsd: number | null;
  /** Their gain in %: on margin (the move × their leverage, Hyperliquid's
   * ROE) while open; once closed, the return × the leverage it had when
   * marked, else at 1× (`gainAt1x`). */
  gainPct: number | null;
  gainAt1x: boolean;
}

/** How close an exit must be to a stop or target to count as hitting it. */
const HIT_BAND = 0.005;
const near = (a: number, b: number | null) => b !== null && b > 0 && Math.abs(a / b - 1) <= HIT_BAND;

const samePosition = (t: TrackedTrade, x: { address: string; coin: string; side: string; openedAt: number | null }) =>
  x.address === t.address && x.coin === t.coin && x.side === t.side && (t.openedAt === null || x.openedAt === null || x.openedAt === t.openedAt);

/** A tracked trade's status from the latest scan: still open (the same
 * position), closed (its close, a stop or a target when the exit sits within
 * 0.5% of the SL or TP it had), or gone from view. */
export function resolveTracked(t: TrackedTrade, entries: readonly ScoutEntry[], closes: readonly ScoutClose[], mids: Record<string, number> | null = null): TrackedView {
  const entry = entries.find((e) => samePosition(t, e));
  if (entry) {
    const live = liveFigures(entry, mids?.[entry.coin]);
    return {
      trade: t,
      status: { kind: "open", move: latestMove(entry), entry },
      price: live.mark,
      entryPx: entry.entryPx,
      vsEntry: live.vsEntry,
      sinceTracked: moveInFavour(t.side, t.at.price, live.mark),
      pnlUsd: live.pnlUsd,
      gainPct: live.roe,
      gainAt1x: false,
    };
  }
  // The close after it was opened (or after it was marked, when its opening
  // isn't known), latest first.
  const close = closes
    .filter((c) => samePosition(t, c) && c.closedAt >= (t.openedAt ?? 0))
    .sort((a, b) => b.closedAt - a.closedAt)
    .find((c) => t.openedAt !== null || c.closedAt >= t.trackedAt - 60_000 || t.at.price === c.exitPx);
  if (close) {
    const kind = near(close.exitPx, t.at.sl) ? "stopped" : near(close.exitPx, t.at.tp) ? "target" : "closed";
    return {
      trade: t,
      status: { kind, close },
      price: close.exitPx,
      entryPx: close.entryPx ?? t.at.entryPx,
      vsEntry: close.returnPct,
      sinceTracked: moveInFavour(t.side, t.at.price, close.exitPx),
      pnlUsd: close.pnlUsd,
      gainPct: close.returnPct === null ? null : close.returnPct * (t.at.leverage ?? 1),
      gainAt1x: t.at.leverage === null,
    };
  }
  return { trade: t, status: { kind: "gone" }, price: null, entryPx: t.at.entryPx, vsEntry: null, sinceTracked: null, pnlUsd: null, gainPct: null, gainAt1x: false };
}

/** The tracked trade a row of the Activity table is (same matching as
 * resolveTracked), so its ☆ shows filled and can untrack it. */
export function findTracked(tracked: readonly TrackedTrade[], x: { address: string; coin: string; side: string; openedAt: number | null }): TrackedTrade | undefined {
  return tracked.find((t) => samePosition(t, x));
}

/** A trade to mark from an open position (its mark now as the price then). */
export function trackOpen(e: ScoutEntry, mark: number | null, nowMs: number): TrackedTrade {
  return { address: e.address, coin: e.coin, side: e.side, openedAt: e.openedAt, trackedAt: nowMs, at: { entryPx: e.entryPx, price: mark, size: e.size, leverage: e.leverage, tp: e.tp, sl: e.sl } };
}

/** A trade to mark from a close (its exit as the price then). */
export function trackClose(c: ScoutClose, nowMs: number): TrackedTrade {
  return { address: c.address, coin: c.coin, side: c.side, openedAt: c.openedAt, trackedAt: nowMs, at: { entryPx: c.entryPx, price: c.exitPx, size: c.size, leverage: null, tp: null, sl: null } };
}

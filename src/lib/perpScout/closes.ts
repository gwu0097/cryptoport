// Positions a trader closed recently, from their fills (pure). A close is a
// position going back to flat (or flipping to the other side); trims along
// the way are part of the same exit. Perp Scout showed only open positions,
// so a closed trade just vanished (owner 2026-10-06: "missing closed
// positions — I copied someone's UNI trade and it's gone").

import type { Fill } from "./entries.ts";

/** How far back Perp Scout's "Recently closed" reaches, in days. */
export const CLOSES_DAYS = 7;

export interface ScoutClose {
  address: string;
  coin: string;
  side: "long" | "short";
  /** When the position was opened; null = before the fills read. */
  openedAt: number | null;
  closedAt: number;
  /** Average entry: from the opening fills when seen, else worked back from
   * the realized PnL; null when neither is known. */
  entryPx: number | null;
  /** Average exit over every reducing fill. */
  exitPx: number;
  /** Size closed, in the coin. */
  size: number;
  /** Realized PnL of the exit, before fees. */
  pnlUsd: number | null;
  /** The move from entry to exit in their direction (a fraction). */
  returnPct: number | null;
}

interface Open {
  side: 1 | -1;
  openedAt: number | null;
  entryQty: number;
  entryCost: number;
  exitQty: number;
  exitValue: number;
  pnl: number;
  pnlKnown: boolean;
}

const sideOf = (x: number, scale: number) => (Math.abs(x) <= 1e-9 * Math.max(1, scale) ? 0 : Math.sign(x));

/** Closes of `address` within the last `days`, newest first. */
export function recentCloses(address: string, fills: readonly Fill[], nowMs: number, days = CLOSES_DAYS): ScoutClose[] {
  const since = nowMs - days * 24 * 60 * 60_000;
  const byCoin = new Map<string, Fill[]>();
  for (const f of fills) byCoin.set(f.coin, [...(byCoin.get(f.coin) ?? []), f]);
  const out: ScoutClose[] = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let cur: Open | null = null;
    for (const f of list) {
      const signed = f.side === "B" ? f.sz : -f.sz;
      const before = sideOf(f.startPosition, f.sz);
      const after = f.startPosition + signed;
      const afterSide = sideOf(after, f.sz);
      // A position already open when the fills start: its entry is unknown.
      if (!cur && before !== 0) cur = { side: before as 1 | -1, openedAt: null, entryQty: 0, entryCost: 0, exitQty: 0, exitValue: 0, pnl: 0, pnlKnown: true };
      if (cur && Math.sign(signed) !== cur.side) {
        // Reducing: up to what was open; the rest (on a flip) opens anew.
        const closing = Math.min(f.sz, Math.abs(f.startPosition));
        cur.exitQty += closing;
        cur.exitValue += closing * f.px;
        if (f.closedPnl === undefined) cur.pnlKnown = false;
        else cur.pnl += f.closedPnl;
        if (afterSide !== cur.side) {
          if (f.time >= since) out.push(toClose(address, coin, cur, f.time));
          cur = null;
        }
      } else if (cur) {
        cur.entryQty += f.sz;
        cur.entryCost += f.sz * f.px;
      }
      if (!cur && afterSide !== 0) {
        const opening = before === 0 ? f.sz : Math.abs(after);
        cur = { side: afterSide as 1 | -1, openedAt: f.time, entryQty: opening, entryCost: opening * f.px, exitQty: 0, exitValue: 0, pnl: 0, pnlKnown: true };
      }
    }
  }
  return out.sort((a, b) => b.closedAt - a.closedAt);
}

function toClose(address: string, coin: string, p: Open, closedAt: number): ScoutClose {
  const exitPx = p.exitValue / p.exitQty;
  const pnl = p.pnlKnown ? p.pnl : null;
  // Entry from the opening fills when the whole position was seen; else from
  // the realized PnL: long pnl = qty × (exit − entry), short the reverse.
  let entryPx: number | null = p.openedAt !== null && p.entryQty > 0 ? p.entryCost / p.entryQty : null;
  if (entryPx === null && pnl !== null) entryPx = exitPx - (p.side * pnl) / p.exitQty;
  const returnPct = entryPx !== null && entryPx > 0 ? p.side * (exitPx / entryPx - 1) : null;
  return { address, coin, side: p.side > 0 ? "long" : "short", openedAt: p.openedAt, closedAt, entryPx, exitPx, size: p.exitQty, pnlUsd: pnl, returnPct };
}

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

/**
 * The last scan's closes plus the new ones, without repeats (a close is its
 * trader, coin and time), within the last `days`, newest first. A new close
 * of a position opened before the fills read gets its opening time from the
 * open position the last scan saw (`openedAt`, keyed `address:coin:side`).
 */
export function mergeCloses(prev: readonly ScoutClose[], fresh: readonly ScoutClose[], nowMs: number, openedAt: ReadonlyMap<string, number> = new Map(), days = CLOSES_DAYS): ScoutClose[] {
  const since = nowMs - days * 24 * 60 * 60_000;
  const byKey = new Map<string, ScoutClose>();
  for (const c of prev) byKey.set(`${c.address}:${c.coin}:${c.closedAt}`, c);
  for (const c of fresh) {
    const known = c.openedAt ?? openedAt.get(`${c.address}:${c.coin}:${c.side}`) ?? null;
    byKey.set(`${c.address}:${c.coin}:${c.closedAt}`, { ...c, openedAt: known !== null && known <= c.closedAt ? known : null });
  }
  return [...byKey.values()].filter((c) => c.closedAt >= since).sort((a, b) => b.closedAt - a.closedAt);
}

/** A trader's closes of one coin on one side in the window, summed: a swing
 * trader who opened and closed HYPE long 6 times reads as one row (owner
 * 2026-10-06: "can we sum them together?"). */
export interface CloseSummary {
  address: string;
  coin: string;
  side: "long" | "short";
  count: number;
  /** Total size closed, in the coin. */
  size: number;
  /** Size-weighted averages over the closes whose entry is known. */
  entryPx: number | null;
  exitPx: number;
  /** Sum of realized PnL; null when any close's is unknown. */
  pnlUsd: number | null;
  /** Combined return: total PnL ÷ the entry value of what was closed, at
   * 1×; null when an entry is unknown. */
  returnPct: number | null;
  /** The earliest known open and the latest close. */
  firstOpenedAt: number | null;
  lastClosedAt: number;
  /** Each close, newest first. */
  closes: ScoutClose[];
}

export function summarizeCloses<T extends ScoutClose>(closes: readonly T[]): (Omit<CloseSummary, "closes"> & { closes: T[] })[] {
  const groups = new Map<string, T[]>();
  for (const c of closes) {
    const key = `${c.address}:${c.coin}:${c.side}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: (Omit<CloseSummary, "closes"> & { closes: T[] })[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.closedAt - a.closedAt);
    const size = list.reduce((s, c) => s + c.size, 0);
    const known = list.filter((c) => c.entryPx !== null);
    const knownSize = known.reduce((s, c) => s + c.size, 0);
    const entryValue = known.reduce((s, c) => s + c.size * c.entryPx!, 0);
    const pnlUsd = list.every((c) => c.pnlUsd !== null) ? list.reduce((s, c) => s + c.pnlUsd!, 0) : null;
    const opens = list.map((c) => c.openedAt).filter((t): t is number => t !== null);
    const first = list[0];
    out.push({
      address: first.address,
      coin: first.coin,
      side: first.side,
      count: list.length,
      size,
      entryPx: knownSize > 0 ? entryValue / knownSize : null,
      exitPx: list.reduce((s, c) => s + c.size * c.exitPx, 0) / size,
      pnlUsd,
      returnPct: pnlUsd !== null && known.length === list.length && entryValue > 0 ? pnlUsd / entryValue : null,
      firstOpenedAt: opens.length ? Math.min(...opens) : null,
      lastClosedAt: first.closedAt,
      closes: list,
    });
  }
  return out.sort((a, b) => b.lastClosedAt - a.lastClosedAt);
}

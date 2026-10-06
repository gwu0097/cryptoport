// A followed trader's open Hyperliquid positions as Perp Scout entries, pure:
// when each was opened and at what price (from the account's fills), its
// average entry, the mark, its TP/SL and how far price has moved since.

import type { PerpAccountState, PerpPositionState } from "../hyperliquidPerps.ts";
import { hyperliquidTpsl, nearestTpsl, type HyperliquidOrder } from "../tpsl.ts";

export interface Fill {
  coin: string;
  px: number;
  sz: number;
  /** B = buy, A = sell. */
  side: "A" | "B";
  time: number;
  /** Signed position size before this fill. */
  startPosition: number;
  oid: number | null;
}

/** userFills / userFillsByTime answer. Unparseable fills are skipped; an
 * answer that isn't a list is an error. */
export function parseFills(json: unknown): Fill[] {
  if (!Array.isArray(json)) throw new Error("Hyperliquid fills: not a list");
  const out: Fill[] = [];
  for (const f of json as Record<string, unknown>[]) {
    const fill = {
      coin: String(f?.coin ?? ""),
      px: Number(f?.px),
      sz: Number(f?.sz),
      side: f?.side === "A" || f?.side === "B" ? f.side : null,
      time: Number(f?.time),
      startPosition: Number(f?.startPosition),
      oid: Number.isFinite(Number(f?.oid)) ? Number(f?.oid) : null,
    };
    if (!fill.coin || !fill.side || ![fill.px, fill.sz, fill.time, fill.startPosition].every(Number.isFinite)) continue;
    out.push(fill as Fill);
  }
  return out;
}

const signOf = (x: number, scale: number) => (Math.abs(x) <= 1e-9 * Math.max(1, scale) ? 0 : Math.sign(x));

export interface Opening {
  /** When the current position was opened (its first fill); null = before
   * the oldest fill read. */
  openedAt: number | null;
  /** Price of that opening order (its fills' average). */
  openPx: number | null;
  /** The last fill that added to it (after opening, when that's known). */
  lastAddAt: number | null;
  /** With openedAt null: the oldest fill read (opened before this). */
  openedBefore: number | null;
}

/** Where the open position in `coin` (signed `size`) began, walking the
 * fills: the last fill that took the position from flat or the other side
 * to this side. */
export function positionOpening(fills: readonly Fill[], coin: string, size: number): Opening {
  const side = Math.sign(size);
  const mine = fills.filter((f) => f.coin === coin).sort((a, b) => a.time - b.time);
  let opener = -1;
  mine.forEach((f, i) => {
    const after = f.startPosition + (f.side === "B" ? f.sz : -f.sz);
    const scale = Math.abs(size);
    if (signOf(f.startPosition, scale) !== side && signOf(after, scale) === side) opener = i;
  });
  const lastAdd = (from: readonly Fill[], skipOid: number | null) => {
    let at: number | null = null;
    for (const f of from) {
      const after = f.startPosition + (f.side === "B" ? f.sz : -f.sz);
      if ((skipOid === null || f.oid !== skipOid) && Math.abs(after) > Math.abs(f.startPosition) && Math.sign(after) === side) at = f.time;
    }
    return at;
  };
  if (opener < 0) {
    // Opened before the fills read: when it was opened is unknown, but adds
    // within them are still seen.
    const oldest = fills.reduce((m, f) => Math.min(m, f.time), Infinity);
    return { openedAt: null, openPx: null, lastAddAt: lastAdd(mine, null), openedBefore: Number.isFinite(oldest) ? oldest : null };
  }
  const first = mine[opener];
  const sameOrder = first.oid === null ? [first] : mine.filter((f) => f.oid === first.oid);
  const qty = sameOrder.reduce((s, f) => s + f.sz, 0);
  const openPx = qty > 0 ? sameOrder.reduce((s, f) => s + f.px * f.sz, 0) / qty : first.px;
  return { openedAt: first.time, openPx, lastAddAt: lastAdd(mine.slice(opener + 1), first.oid), openedBefore: null };
}

export interface ScoutEntry {
  address: string;
  coin: string;
  side: "long" | "short";
  /** In the coin, unsigned. */
  size: number;
  notionalUsd: number | null;
  /** Hyperliquid's average entry (moves when they add). */
  entryPx: number | null;
  openPx: number | null;
  openedAt: number | null;
  openedBefore: number | null;
  lastAddAt: number | null;
  /** The mark when the account was read. */
  markPx: number | null;
  unrealizedPnl: number | null;
  /** Return on the position's margin, a fraction. */
  roe: number | null;
  leverage: number | null;
  marginMode: string | null;
  liquidationPx: number | null;
  /** Notional ÷ the account's value. */
  equityShare: number | null;
  /** The nearest take-profit and stop; null with tpslKnown false = orders
   * not read. */
  tp: number | null;
  sl: number | null;
  tpslMore: number;
  tpslKnown: boolean;
}

export type ScoutPosition = PerpPositionState & { positionValue?: string };
export type ScoutAccountState = Omit<PerpAccountState, "assetPositions"> & { assetPositions: { type: string; position: ScoutPosition }[] };

const finite = (x: unknown): number | null => {
  const n = Number(x);
  return x !== null && x !== undefined && x !== "" && Number.isFinite(n) ? n : null;
};

/** Every open position of one account. `orders` null = not read.
 * `equity`: the whole account's value (perps + spot) when known — a unified
 * account's cash sits in spot, so the perps side alone overstates each
 * position's share; else the perps account's value. */
export function buildEntries(address: string, state: ScoutAccountState, fills: readonly Fill[], orders: readonly HyperliquidOrder[] | null, equity: number | null = finite(state.marginSummary?.accountValue)): ScoutEntry[] {
  const out: ScoutEntry[] = [];
  for (const { position: p } of state.assetPositions) {
    const szi = Number(p.szi);
    if (!Number.isFinite(szi) || szi === 0) continue;
    const side = szi > 0 ? "long" : "short";
    const size = Math.abs(szi);
    const notional = finite(p.positionValue);
    const tpsl = orders ? hyperliquidTpsl(orders, p.coin, side) : null;
    const near = tpsl ? nearestTpsl(tpsl, side) : { tp: null, sl: null, more: 0 };
    const opening = positionOpening(fills, p.coin, szi);
    out.push({
      address,
      coin: p.coin,
      side,
      size,
      notionalUsd: notional,
      entryPx: finite(p.entryPx),
      openPx: opening.openPx,
      openedAt: opening.openedAt,
      openedBefore: opening.openedBefore,
      lastAddAt: opening.lastAddAt,
      markPx: notional !== null ? notional / size : null,
      unrealizedPnl: finite(p.unrealizedPnl),
      roe: finite(p.returnOnEquity),
      leverage: finite(p.leverage?.value),
      marginMode: p.leverage?.type ?? null,
      liquidationPx: finite(p.liquidationPx),
      equityShare: notional !== null && equity !== null && equity > 0 ? notional / equity : null,
      tp: near.tp,
      sl: near.sl,
      tpslMore: near.more,
      tpslKnown: tpsl !== null,
    });
  }
  return out;
}

/** How far price has moved from `from` in the trader's direction, a
 * fraction: negative = they're down there, i.e. price is now better than
 * their entry (below it for a long, above it for a short). */
export function moveInFavour(side: "long" | "short", from: number | null, mark: number | null): number | null {
  if (from === null || mark === null || !(from > 0) || !(mark > 0)) return null;
  return side === "long" ? mark / from - 1 : 1 - mark / from;
}

/** Total notional ÷ account value (the whole account's when given, as in
 * buildEntries): how levered the whole book is. */
export function accountLeverage(state: ScoutAccountState, equity: number | null = finite(state.marginSummary?.accountValue)): number | null {
  if (equity === null || equity <= 0) return null;
  let notional = 0;
  for (const { position } of state.assetPositions) {
    const v = finite(position.positionValue);
    if (v !== null) notional += Math.abs(v);
  }
  return notional / equity;
}

/** Long minus short notional ÷ total: +1 all long, −1 all short, 0 hedged;
 * null with no positions. */
export function netBias(entries: readonly ScoutEntry[]): number | null {
  let long = 0;
  let short = 0;
  for (const e of entries) {
    if (e.notionalUsd === null) continue;
    if (e.side === "long") long += e.notionalUsd;
    else short += e.notionalUsd;
  }
  return long + short > 0 ? (long - short) / (long + short) : null;
}

export interface LiveFigures {
  mark: number | null;
  notionalUsd: number | null;
  /** Unrealized PnL at `mark` from their average entry. */
  pnlUsd: number | null;
  vsEntry: number | null;
  vsOpen: number | null;
}

/** An entry's figures at a newer mark (Refresh prices), else at the scan's. */
export function liveFigures(e: ScoutEntry, mid: number | null | undefined): LiveFigures {
  const mark = mid && mid > 0 ? mid : e.markPx;
  const pnlUsd = mark !== null && e.entryPx !== null ? e.size * (e.side === "long" ? mark - e.entryPx : e.entryPx - mark) : null;
  return {
    mark,
    notionalUsd: mark !== null ? e.size * mark : e.notionalUsd,
    pnlUsd,
    vsEntry: moveInFavour(e.side, e.entryPx, mark),
    vsOpen: moveInFavour(e.side, e.openPx, mark),
  };
}

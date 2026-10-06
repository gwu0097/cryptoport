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
  /** Realized PnL of a reducing fill, in USDC (fees not included); 0 on an
   * opening one, absent when not given. */
  closedPnl?: number;
}

/** userFills / userFillsByTime answer, oldest first. Unparseable fills are
 * skipped, and so are spot trades ("@107", "PURR/USDC": not perp positions).
 * userFills lists newest first, and the pieces of one order filled in the
 * same millisecond in that reverse order too — re-sorting by time kept them
 * backwards, so the position seemed to go flat and reopen between pieces
 * (0xf97a's one HYPE trade read as 8 closes, 2026-10-06). The list is
 * reversed instead, which keeps each order's pieces in sequence; an answer
 * already oldest first (userFillsByTime) is kept as it is. An answer that
 * isn't a list is an error. */
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
      ...(Number.isFinite(Number(f?.closedPnl)) && f?.closedPnl !== undefined ? { closedPnl: Number(f.closedPnl) } : {}),
    };
    if (!fill.coin || !fill.side || ![fill.px, fill.sz, fill.time, fill.startPosition].every(Number.isFinite)) continue;
    if (fill.coin.startsWith("@") || fill.coin.includes("/")) continue;
    out.push(fill as Fill);
  }
  return out.length > 1 && out[0].time > out[out.length - 1].time ? out.reverse() : out;
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
  /** The last fill that cut it without closing or flipping it. */
  lastTrimAt: number | null;
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
  const lastTrim = (from: readonly Fill[]) => {
    let at: number | null = null;
    for (const f of from) {
      const after = f.startPosition + (f.side === "B" ? f.sz : -f.sz);
      if (Math.sign(f.startPosition) === side && Math.sign(after) === side && Math.abs(after) < Math.abs(f.startPosition)) at = f.time;
    }
    return at;
  };
  if (opener < 0) {
    // Opened before the fills read: when it was opened is unknown, but adds
    // within them are still seen.
    const oldest = fills.reduce((m, f) => Math.min(m, f.time), Infinity);
    return { openedAt: null, openPx: null, lastAddAt: lastAdd(mine, null), lastTrimAt: lastTrim(mine), openedBefore: Number.isFinite(oldest) ? oldest : null };
  }
  const first = mine[opener];
  const sameOrder = first.oid === null ? [first] : mine.filter((f) => f.oid === first.oid);
  const qty = sameOrder.reduce((s, f) => s + f.sz, 0);
  const openPx = qty > 0 ? sameOrder.reduce((s, f) => s + f.px * f.sz, 0) / qty : first.px;
  const after = mine.slice(opener + 1);
  return { openedAt: first.time, openPx, lastAddAt: lastAdd(after, first.oid), lastTrimAt: lastTrim(after), openedBefore: null };
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
  /** Absent on scans saved before trims were read. */
  lastTrimAt?: number | null;
  /** The coin's logo, set by the scan (icon cache); absent = none. */
  iconUrl?: string | null;
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
      lastTrimAt: opening.lastTrimAt,
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
  /** Their return on margin: the move since their entry × their leverage
   * (Hyperliquid's ROE) — a % that doesn't depend on their size. */
  roe: number | null;
}

/** An entry's figures at a newer mark (Refresh prices), else at the scan's. */
export function liveFigures(e: ScoutEntry, mid: number | null | undefined): LiveFigures {
  const mark = mid && mid > 0 ? mid : e.markPx;
  const pnlUsd = mark !== null && e.entryPx !== null ? e.size * (e.side === "long" ? mark - e.entryPx : e.entryPx - mark) : null;
  const vsEntry = moveInFavour(e.side, e.entryPx, mark);
  return {
    mark,
    notionalUsd: mark !== null ? e.size * mark : e.notionalUsd,
    pnlUsd,
    vsEntry,
    vsOpen: moveInFavour(e.side, e.openPx, mark),
    roe: vsEntry !== null && e.leverage !== null && e.leverage > 0 ? vsEntry * e.leverage : null,
  };
}

export type PositionRole = "directional" | "hedge" | "pair" | "book";

/** How long apart two opposite positions can be opened and still count as
 * one pair trade. */
const PAIR_WINDOW_MS = 2 * 60 * 60_000;
/** |net bias| at or above which a book leans one way. */
const LEAN = 0.5;
/** |net bias| under which a book is balanced long/short. */
const BALANCED = 0.3;

/**
 * What a position is to its trader, read from the rest of their book —
 * Hyperliquid doesn't say, so this is an inference with its reason:
 *  - pair: opened within 2 h of an opposite-side position (a pair trade);
 *  - hedge: against a book that leans clearly the other way;
 *  - book: one leg of a roughly balanced long/short book;
 *  - directional: with the book's lean, or the only position.
 */
export function positionRole(e: ScoutEntry, book: readonly ScoutEntry[]): { role: PositionRole; why: string } {
  if (e.openedAt !== null) {
    const partners = book.filter((o) => o.side !== e.side && o.openedAt !== null && Math.abs(o.openedAt - e.openedAt!) <= PAIR_WINDOW_MS);
    if (partners.length) return { role: "pair", why: `Opened with ${partners.map((p) => `${p.coin} ${p.side}`).join(", ")} on the other side (within 2 h)` };
  }
  const others = book.filter((o) => o !== e);
  if (others.length === 0) return { role: "directional", why: "Their only open position" };
  const bias = netBias(book);
  if (bias === null) return { role: "directional", why: "Book size unknown" };
  const pct = `${Math.round(Math.abs(bias) * 100)}%`;
  const lean = bias > 0 ? "long" : "short";
  if (Math.abs(bias) < BALANCED) return { role: "book", why: `One leg of a balanced long/short book (net ${pct} ${lean})` };
  if (Math.abs(bias) >= LEAN && lean !== e.side) return { role: "hedge", why: `Against a book that's net ${pct} ${lean}` };
  return { role: lean === e.side ? "directional" : "book", why: lean === e.side ? `With the book's lean (net ${pct} ${lean})` : `Against a mildly ${lean} book (net ${pct})` };
}

export type MoveKind = "new" | "add" | "trim";

/** A position's most recent move seen in the fills read: opened, added to,
 * or trimmed; null when none of them is (opened before the fills, untouched
 * since). */
export function latestMove(e: Pick<ScoutEntry, "openedAt" | "lastAddAt" | "lastTrimAt">): { kind: MoveKind; at: number } | null {
  const moves: { kind: MoveKind; at: number | null | undefined }[] = [
    { kind: "new", at: e.openedAt },
    { kind: "add", at: e.lastAddAt },
    { kind: "trim", at: e.lastTrimAt },
  ];
  let best: { kind: MoveKind; at: number } | null = null;
  for (const m of moves) if (m.at != null && (best === null || m.at >= best.at)) best = { kind: m.kind, at: m.at };
  return best;
}

/**
 * An entry built from only the fills since the last scan, completed from the
 * same position in that scan (same coin and side): when it was opened and at
 * what price come from before unless the new fills opened it; the latest add
 * and trim are the later of the two. Without a previous entry, or after a
 * flip, the new entry stands as it is.
 */
export function carryOver(fresh: ScoutEntry, prev: ScoutEntry | undefined): ScoutEntry {
  if (!prev || prev.side !== fresh.side || fresh.openedAt !== null) return fresh;
  const later = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.max(a, b));
  return {
    ...fresh,
    openedAt: prev.openedAt,
    openPx: prev.openPx,
    openedBefore: prev.openedAt === null ? prev.openedBefore : null,
    lastAddAt: later(fresh.lastAddAt, prev.lastAddAt),
    lastTrimAt: later(fresh.lastTrimAt, prev.lastTrimAt),
  };
}

/** TP/SL kept from the last scan when the orders weren't read again. */
export function keepTpsl(entry: ScoutEntry, prev: ScoutEntry | undefined): ScoutEntry {
  if (entry.tpslKnown || !prev || prev.side !== entry.side) return entry;
  return { ...entry, tp: prev.tp, sl: prev.sl, tpslMore: prev.tpslMore, tpslKnown: prev.tpslKnown };
}

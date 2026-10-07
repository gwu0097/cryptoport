// Perp Scout's Discord alerts (owner 2026-10-07; docs/perp-scout/PLAN.md
// "Alerts"): what changed in a followed trader's positions between two reads,
// and the message for it. Pure — the polling script (scripts/perp-alerts.ts,
// on the owner's Mac mini) reads Hyperliquid and posts.
//
// One message per position change, never per fill (one trader makes ~285
// fills a day): opened (pings), closed (with its result), flipped, and an add
// or trim only once the position has moved STEP from the size last alerted —
// so scaling in 10% at a time posts once it adds up.

import type { Fill } from "./entries.ts";
import { formatCompactUsd, formatPrice } from "../format.ts";

/** An add or trim posts once the size moved this far from the last alert. */
export const STEP = 0.25;
/** At most this many messages per trader an hour; the rest are counted. */
export const MAX_PER_TRADER_HOUR = 10;

/** One open position as read (clearinghouseState). `szi` is signed. */
export interface ReadPosition {
  coin: string;
  szi: number;
  entryPx: number | null;
  leverage: number | null;
  liquidationPx: number | null;
  notionalUsd: number | null;
}

/** A position as remembered between reads. */
export interface HeldPosition extends ReadPosition {
  /** The size (signed) when it was last alerted: the add/trim baseline. */
  alertedSzi: number;
  /** When that was (ms): a close's exit is read from fills after it. */
  alertedAt: number;
}

export type Book = Record<string, HeldPosition>;

export type Side = "long" | "short";

export type Change =
  | { kind: "opened"; coin: string; side: Side; now: ReadPosition }
  | { kind: "closed"; coin: string; side: Side; was: HeldPosition }
  | { kind: "flipped"; coin: string; side: Side; was: HeldPosition; now: ReadPosition }
  | { kind: "added" | "trimmed"; coin: string; side: Side; was: HeldPosition; now: ReadPosition };

const sideOf = (szi: number): Side => (szi > 0 ? "long" : "short");

/** What changed since the last read, and the book to remember. A trader seen
 * for the first time (`prev` null) only sets the baseline: nothing posts. */
export function diffBook(prev: Book | null, positions: readonly ReadPosition[], nowMs: number): { changes: Change[]; book: Book } {
  const book: Book = {};
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const p of positions) {
    if (!Number.isFinite(p.szi) || p.szi === 0) continue;
    seen.add(p.coin);
    const was = prev?.[p.coin];
    if (!prev) {
      book[p.coin] = { ...p, alertedSzi: p.szi, alertedAt: nowMs };
    } else if (!was) {
      changes.push({ kind: "opened", coin: p.coin, side: sideOf(p.szi), now: p });
      book[p.coin] = { ...p, alertedSzi: p.szi, alertedAt: nowMs };
    } else if (Math.sign(was.szi) !== Math.sign(p.szi)) {
      changes.push({ kind: "flipped", coin: p.coin, side: sideOf(p.szi), was, now: p });
      book[p.coin] = { ...p, alertedSzi: p.szi, alertedAt: nowMs };
    } else {
      const base = Math.abs(was.alertedSzi);
      const size = Math.abs(p.szi);
      const kind = size >= base * (1 + STEP) ? "added" : size <= base * (1 - STEP) ? "trimmed" : null;
      if (kind) changes.push({ kind, coin: p.coin, side: sideOf(p.szi), was, now: p });
      book[p.coin] = kind ? { ...p, alertedSzi: p.szi, alertedAt: nowMs } : { ...p, alertedSzi: was.alertedSzi, alertedAt: was.alertedAt };
    }
  }
  for (const [coin, was] of Object.entries(prev ?? {})) {
    if (!seen.has(coin)) changes.push({ kind: "closed", coin, side: sideOf(was.szi), was });
  }
  return { changes, book };
}

export interface CloseResult {
  exitPx: number;
  /** Realized PnL of the exit, before fees; null when the fills don't say. */
  pnlUsd: number | null;
  /** The move from entry to exit in their direction (a fraction, at 1×). */
  returnPct: number | null;
}

/** The exit of a closed (or flipped) position, from the fills after its last
 * alert: every fill that reduced it, averaged. Null when none was read. */
export function closeResult(fills: readonly Fill[], was: HeldPosition): CloseResult | null {
  const long = was.szi > 0;
  let qty = 0;
  let value = 0;
  let pnl = 0;
  let pnlKnown = false;
  for (const f of fills) {
    if (f.coin !== was.coin || f.time < was.alertedAt) continue;
    // A reducing fill sells a long (A) or buys back a short (B); on a flip only
    // the part that brings it to zero closes.
    const reduces = long ? f.side === "A" && f.startPosition > 0 : f.side === "B" && f.startPosition < 0;
    if (!reduces) continue;
    const q = Math.min(f.sz, Math.abs(f.startPosition));
    qty += q;
    value += q * f.px;
    if (f.closedPnl !== undefined) {
      pnl += f.closedPnl;
      pnlKnown = true;
    }
  }
  if (qty <= 0) return null;
  const exitPx = value / qty;
  const entry = was.entryPx;
  return { exitPx, pnlUsd: pnlKnown ? pnl : null, returnPct: entry ? ((exitPx - entry) / entry) * (long ? 1 : -1) : null };
}

/** Takes one of the trader's hourly messages; false = over the cap (the
 * caller counts it and says so once the hour turns). Prunes `sentAt`. */
export function takeBudget(sentAt: number[], nowMs: number, max = MAX_PER_TRADER_HOUR): boolean {
  while (sentAt.length && sentAt[0] <= nowMs - 3_600_000) sentAt.shift();
  if (sentAt.length >= max) return false;
  sentAt.push(nowMs);
  return true;
}

/** What a message can say beyond the change itself. */
export interface AlertContext {
  traderName: string;
  address: string;
  /** The whole account's value (portfolio), for an open's share of it. */
  accountValue?: number | null;
  /** The opened position's nearest take-profit and stop; undefined = not read. */
  tpsl?: { tp: number | null; sl: number | null };
  /** A close's or flip's exit; null = its fills weren't read. */
  result?: CloseResult | null;
  /** The script was off this long before this read (the move may be older). */
  lateMs?: number;
}

export interface AlertMessage {
  /** Only an open pings (owner: "alerting specifically if there's a new position"). */
  ping: boolean;
  embed: { title: string; url: string; description: string; color: number };
}

const GREEN = 0x22c55e;
const RED = 0xef4444;
const BLUE = 0x3b82f6;
const AMBER = 0xf59e0b;
const GREY = 0x9ca3af;
const PURPLE = 0xa855f7;

const pct = (x: number) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(Math.abs(x) >= 0.1 ? 1 : 2)}%`;
const lev = (x: number | null) => (x ? ` · ${Math.round(x * 10) / 10}x` : "");
const price = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : formatPrice(x));
const SIDE = { long: "LONG", short: "SHORT" } as const;

function resultLine(was: HeldPosition, r: CloseResult | null | undefined): { line: string; good: boolean | null } {
  if (!r) return { line: `Entry ${price(was.entryPx)} · exit not read`, good: null };
  const parts = [`Entry ${price(was.entryPx)} → exit ${price(r.exitPx)}`];
  if (r.returnPct !== null) parts.push(`${pct(r.returnPct)}${was.leverage && was.leverage !== 1 ? ` (${pct(r.returnPct * was.leverage)} on margin at ${Math.round(was.leverage * 10) / 10}x)` : ""}`);
  if (r.pnlUsd !== null) parts.push(`this exit's PnL ${r.pnlUsd >= 0 ? "+" : "−"}${formatCompactUsd(Math.abs(r.pnlUsd))}`);
  const basis = r.returnPct ?? r.pnlUsd;
  return { line: parts.join(" · "), good: basis === null ? null : basis >= 0 };
}

/** The Discord card for a change. */
export function alertMessage(change: Change, ctx: AlertContext): AlertMessage {
  const who = ctx.traderName;
  const url = `https://hyperdash.com/trader/${ctx.address}`;
  const lines: string[] = [];
  let title: string;
  let color: number;
  switch (change.kind) {
    case "opened": {
      const n = change.now;
      title = `🟢 ${who} opened ${SIDE[change.side]} ${change.coin}${lev(n.leverage)}`;
      color = GREEN;
      const share = n.notionalUsd && ctx.accountValue ? ` (${Math.round((n.notionalUsd / ctx.accountValue) * 1000) / 10}% of account)` : "";
      lines.push(`Size ${formatCompactUsd(n.notionalUsd)}${share} · entry ${price(n.entryPx)} · liq ${price(n.liquidationPx)}`);
      if (ctx.tpsl) lines.push(`TP ${ctx.tpsl.tp === null ? "none" : price(ctx.tpsl.tp)} · SL ${ctx.tpsl.sl === null ? "none" : price(ctx.tpsl.sl)}`);
      break;
    }
    case "closed": {
      const r = resultLine(change.was, ctx.result);
      title = `${r.good === null ? "⚪" : r.good ? "✅" : "❌"} ${who} closed ${SIDE[change.side]} ${change.coin}${r.good !== null && ctx.result?.returnPct != null ? ` · ${pct(ctx.result.returnPct)}` : ""}`;
      color = r.good === null ? GREY : r.good ? GREEN : RED;
      lines.push(r.line);
      break;
    }
    case "flipped": {
      const r = resultLine(change.was, ctx.result);
      title = `🔁 ${who} flipped ${change.coin}: ${SIDE[change.side === "long" ? "short" : "long"]} → ${SIDE[change.side]}${lev(change.now.leverage)}`;
      color = PURPLE;
      lines.push(`Closed: ${r.line}`, `Now ${SIDE[change.side]} ${formatCompactUsd(change.now.notionalUsd)} · entry ${price(change.now.entryPx)}`);
      break;
    }
    case "added":
    case "trimmed": {
      const from = Math.abs(change.was.alertedSzi);
      const to = Math.abs(change.now.szi);
      const move = from > 0 ? (to - from) / from : 0;
      title = `${change.kind === "added" ? "🔵" : "🟠"} ${who} ${change.kind === "added" ? "added to" : "trimmed"} ${SIDE[change.side]} ${change.coin} (${pct(move)})`;
      color = change.kind === "added" ? BLUE : AMBER;
      lines.push(`Size now ${formatCompactUsd(change.now.notionalUsd)} · avg entry ${price(change.now.entryPx)}${lev(change.now.leverage)}`);
      break;
    }
  }
  if (ctx.lateMs && ctx.lateMs > 10 * 60_000) lines.push(`_Seen late: the alert script was off for ${Math.round(ctx.lateMs / 60_000)} min — this may be older._`);
  lines.push(`[HyperDash](${url}) · [${change.coin} on Hyperliquid](https://app.hyperliquid.xyz/trade/${encodeURIComponent(change.coin)})`);
  return { ping: change.kind === "opened", embed: { title: title.slice(0, 256), url, description: lines.join("\n"), color } };
}

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
  /** Open PnL now, in USDC, and as a return on margin (a fraction). */
  unrealizedPnl?: number | null;
  roe?: number | null;
}

/** A position as remembered between reads. */
export interface HeldPosition extends ReadPosition {
  /** The size (signed) when it was last alerted: the add/trim baseline. */
  alertedSzi: number;
  /** When that was (ms): a close's exit is read from fills after it. */
  alertedAt: number;
  /** When it was opened: seen opening, or found in the fills at its first
   * alert; null = before the fills read (then `openedBefore`); absent = not
   * looked up yet (open before the script started). */
  openedAt?: number | null;
  openedBefore?: number | null;
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
      book[p.coin] = { ...p, alertedSzi: p.szi, alertedAt: nowMs, openedAt: nowMs };
    } else if (Math.sign(was.szi) !== Math.sign(p.szi)) {
      changes.push({ kind: "flipped", coin: p.coin, side: sideOf(p.szi), was, now: p });
      book[p.coin] = { ...p, alertedSzi: p.szi, alertedAt: nowMs, openedAt: nowMs };
    } else {
      const base = Math.abs(was.alertedSzi);
      const size = Math.abs(p.szi);
      const kind = size >= base * (1 + STEP) ? "added" : size <= base * (1 - STEP) ? "trimmed" : null;
      if (kind) changes.push({ kind, coin: p.coin, side: sideOf(p.szi), was, now: p });
      const opened = { openedAt: was.openedAt, openedBefore: was.openedBefore };
      book[p.coin] = kind ? { ...p, ...opened, alertedSzi: p.szi, alertedAt: nowMs } : { ...p, ...opened, alertedSzi: was.alertedSzi, alertedAt: was.alertedAt };
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
export function closeResult(fills: readonly Fill[], was: HeldPosition, sinceMs: number = was.alertedAt): CloseResult | null {
  const long = was.szi > 0;
  let qty = 0;
  let value = 0;
  let pnl = 0;
  let pnlKnown = false;
  for (const f of fills) {
    if (f.coin !== was.coin || f.time < sinceMs) continue;
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

/** The average price of the fills that grew the position since its last
 * alert (an add's buys, a short's sells). Null when none was read. */
export function addPrice(fills: readonly Fill[], was: HeldPosition): number | null {
  const long = was.szi > 0;
  let qty = 0;
  let value = 0;
  for (const f of fills) {
    if (f.coin !== was.coin || f.time < was.alertedAt) continue;
    const grows = long ? f.side === "B" && f.startPosition >= 0 : f.side === "A" && f.startPosition <= 0;
    if (!grows) continue;
    qty += f.sz;
    value += f.sz * f.px;
  }
  return qty > 0 ? value / qty : null;
}

/** "40 min", "5h 20m", "3d 4h". */
export function heldFor(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
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
  /** A close's, flip's or trim's exit; null = its fills weren't read. */
  result?: CloseResult | null;
  /** An add's average buy (or a short's sell) price. */
  addPx?: number | null;
  /** When the position was opened (null = before `openedBefore`, unknown
   * when both are absent), and the moment of this read. */
  openedAt?: number | null;
  openedBefore?: number | null;
  nowMs?: number;
  /** The script was off this long before this read (the move may be older). */
  lateMs?: number;
}

export interface AlertMessage {
  /** Opens and closes ping (owner: "alerting specifically if there's a new
   * position"; 2026-10-08: "when a position is closed, tag me"). Adds, trims
   * and flips post silently. */
  ping: boolean;
  /** The text card (its description is the labeled table — what posts when
   * the image can't be drawn). */
  embed: { title: string; url: string; description: string; color: number };
  /** The same values for the image card (alertCardImage.ts), and the links
   * that sit under it. */
  card: AlertCard;
  links: string;
}

/** One column of a card: its label and value; a tone colours the value. */
export interface CardCell {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "muted";
}

/** What the image card shows (owner 2026-10-08: "more polished… a table"). */
export interface AlertCard {
  /** "OPENED", "CLOSED · WIN"… — small, in the accent colour. */
  kind: string;
  /** The accent (hex), the same colour as the embed. */
  accent: string;
  /** "PYTH LONG". */
  title: string;
  /** The big number on the right and its tone. */
  headline: string;
  headTone: "pos" | "neg" | "plain";
  /** The trader, then held time / leverage. */
  sub: string;
  cells: CardCell[];
}

const GREEN = 0x22c55e;
const RED = 0xef4444;
const BLUE = 0x3b82f6;
const AMBER = 0xf59e0b;
const GREY = 0x9ca3af;
const PURPLE = 0xa855f7;

const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(Math.abs(x) >= 0.1 ? 1 : 2)}%`);
const levText = (x: number | null | undefined) => (x ? `${Math.round(x * 10) / 10}x` : "—");
const price = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : formatPrice(x));
const usd = (x: number | null | undefined, signed = false) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `${signed ? (x >= 0 ? "+" : "-") : ""}${formatCompactUsd(Math.abs(x))}`;
const share = (value: number | null | undefined, account: number | null | undefined) => (value && account ? `${Math.round((value / account) * 1000) / 10}%` : "—");
const SIDE = { long: "LONG", short: "SHORT" } as const;

/** "15h05m", "3d4h", "40m". */
function heldShort(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** How long it's been open: exact when known, "7d+" when it predates the
 * fills read, "—" when unknown. */
function heldCell(ctx: AlertContext): string {
  if (!ctx.nowMs) return "—";
  if (ctx.openedAt) return heldShort(ctx.nowMs - ctx.openedAt);
  if (ctx.openedBefore) return `${heldShort(ctx.nowMs - ctx.openedBefore).replace(/\d+[hm]$/, "")}+`;
  return "—";
}

/** One labeled row: a header and its values, columns padded to line up
 * (owner 2026-10-08: "a table format, each value clear"). */
export function table(columns: readonly [string, string][]): string {
  const widths = columns.map(([h, v]) => Math.max(h.length, v.length));
  const row = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return "```\n" + row(columns.map(([h]) => h)) + "\n" + row(columns.map(([, v]) => v)) + "\n```";
}

/** A position's size at today's price, from the size last alerted. */
const valueOf = (szi: number, now: ReadPosition) => (now.notionalUsd && now.szi ? Math.abs(szi) * (now.notionalUsd / Math.abs(now.szi)) : null);

const toneOf = (x: number | null | undefined): CardCell["tone"] => (x === null || x === undefined || !Number.isFinite(x) || x === 0 ? undefined : x > 0 ? "pos" : "neg");
const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** The Discord card for a change: a title line (kind, trader, coin, the
 * headline number), then the values — drawn as an image card with a real
 * table (alertCardImage.ts), or as one labeled text row when it can't be.
 * Colours: green open, blue add, amber trim, green/red close by result,
 * purple flip. */
export function alertMessage(change: Change, ctx: AlertContext): AlertMessage {
  const who = ctx.traderName;
  const url = `https://hyperdash.com/trader/${ctx.address}`;
  const coinSide = `${change.coin} ${SIDE[change.side]}`;
  const head = (emoji: string, kind: string, tail = "") => `${emoji} ${kind} · ${who} · ${coinSide}${tail}`;
  const held = heldCell(ctx);
  let title: string;
  let color: number;
  let cells: CardCell[];
  let card: Omit<AlertCard, "accent" | "cells">;
  switch (change.kind) {
    case "opened": {
      const n = change.now;
      const acct = share(n.notionalUsd, ctx.accountValue);
      title = head("🟢", "OPEN");
      color = GREEN;
      cells = [
        { label: "Entry", value: price(n.entryPx) },
        { label: "Size", value: usd(n.notionalUsd) },
        { label: "Lev", value: levText(n.leverage) },
        { label: "Liq", value: price(n.liquidationPx) },
        { label: "TP", value: ctx.tpsl ? (ctx.tpsl.tp === null ? "none" : price(ctx.tpsl.tp)) : "—", tone: ctx.tpsl?.tp ? "pos" : "muted" },
        { label: "SL", value: ctx.tpsl ? (ctx.tpsl.sl === null ? "none" : price(ctx.tpsl.sl)) : "—", tone: ctx.tpsl?.sl ? "neg" : "muted" },
        { label: "% Acct", value: acct },
      ];
      card = { kind: "OPENED", title: coinSide, headline: acct === "—" ? usd(n.notionalUsd) : `${acct} of acct`, headTone: "plain", sub: `${who} · ${levText(n.leverage)}` };
      break;
    }
    case "added":
    case "trimmed": {
      const before = valueOf(change.was.alertedSzi, change.now);
      const moved = before !== null && change.now.notionalUsd !== null ? change.now.notionalUsd - before : null;
      const step = Math.abs(change.was.alertedSzi) > 0 ? (Math.abs(change.now.szi) - Math.abs(change.was.alertedSzi)) / Math.abs(change.was.alertedSzi) : null;
      const added = change.kind === "added";
      title = head(added ? "🔵" : "🟠", added ? "ADD" : "TRIM", ` · ${pct(step)}`);
      color = added ? BLUE : AMBER;
      cells = [
        { label: added ? "Added" : "Sold", value: usd(moved, true) },
        { label: "Price", value: price(added ? ctx.addPx : ctx.result?.exitPx) },
        { label: "Size", value: usd(change.now.notionalUsd) },
        { label: "% Acct", value: share(change.now.notionalUsd, ctx.accountValue) },
        { label: "Lev", value: levText(change.now.leverage) },
        { label: "Avg entry", value: price(change.now.entryPx) },
        { label: "P/L", value: pct(change.now.roe), tone: toneOf(change.now.roe) },
        { label: "Held", value: held },
      ];
      card = { kind: added ? "ADDED" : "TRIMMED", title: coinSide, headline: pct(step), headTone: "plain", sub: `${who} · held ${held}` };
      break;
    }
    case "closed": {
      const r = ctx.result;
      const move = r?.returnPct ?? null;
      const onMargin = move !== null && change.was.leverage ? move * change.was.leverage : move;
      const good = move === null ? (r?.pnlUsd == null ? null : r.pnlUsd >= 0) : move >= 0;
      title = head(good === null ? "⚪" : good ? "✅" : "❌", "CLOSE", move !== null ? ` · ${pct(move)}` : "");
      color = good === null ? GREY : good ? GREEN : RED;
      cells = [
        { label: "Entry", value: price(change.was.entryPx) },
        { label: "Exit", value: price(r?.exitPx) },
        { label: "Move", value: pct(move), tone: toneOf(move) },
        { label: "Lev", value: levText(change.was.leverage) },
        { label: "P/L", value: pct(onMargin), tone: toneOf(onMargin) },
        { label: "$ P/L", value: usd(r?.pnlUsd, true), tone: toneOf(r?.pnlUsd) },
        { label: "% Acct", value: share(change.was.notionalUsd, ctx.accountValue) },
        { label: "Held", value: held },
      ];
      card = {
        kind: good === null ? "CLOSED" : good ? "CLOSED · WIN" : "CLOSED · LOSS",
        title: coinSide,
        headline: pct(onMargin),
        headTone: good === null ? "plain" : good ? "pos" : "neg",
        sub: `${who} · held ${held}`,
      };
      break;
    }
    case "flipped": {
      const r = ctx.result;
      const old = change.side === "long" ? "short" : "long";
      const closedPl = r?.returnPct != null && change.was.leverage ? r.returnPct * change.was.leverage : (r?.returnPct ?? null);
      title = `🔁 FLIP · ${who} · ${change.coin} ${SIDE[old]} → ${SIDE[change.side]}`;
      color = PURPLE;
      cells = [
        { label: "Closed", value: SIDE[old] },
        { label: "P/L", value: pct(closedPl), tone: toneOf(closedPl) },
        { label: "$ P/L", value: usd(r?.pnlUsd, true), tone: toneOf(r?.pnlUsd) },
        { label: "New", value: SIDE[change.side] },
        { label: "Lev", value: levText(change.now.leverage) },
        { label: "Entry", value: price(change.now.entryPx) },
        { label: "Size", value: usd(change.now.notionalUsd) },
        { label: "% Acct", value: share(change.now.notionalUsd, ctx.accountValue) },
      ];
      card = { kind: "FLIPPED", title: `${change.coin} ${SIDE[old]} > ${SIDE[change.side]}`, headline: pct(closedPl), headTone: closedPl === null ? "plain" : closedPl >= 0 ? "pos" : "neg", sub: `${who} · now ${levText(change.now.leverage)}` };
      break;
    }
  }
  const linkLines: string[] = [];
  if (ctx.lateMs && ctx.lateMs > 10 * 60_000) linkLines.push(`_Seen late: the alert script was off for ${Math.round(ctx.lateMs / 60_000)} min — this may be older._`);
  linkLines.push(`[HyperDash](${url}) · [Chart](https://app.hyperliquid.xyz/trade/${encodeURIComponent(change.coin)})`);
  const links = linkLines.join("\n");
  return {
    ping: change.kind === "opened" || change.kind === "closed",
    embed: { title: title.slice(0, 256), url, description: `${table(cells.map((c) => [c.label, c.value]))}\n${links}`, color },
    card: { ...card, accent: hex(color), cells },
    links,
  };
}

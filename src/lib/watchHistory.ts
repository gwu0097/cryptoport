// Wallet Watch "Recent trades" (owner 2026-09-28): an influencer's EVM
// trades over the last 7 or 30 days, on demand, shown per coin like the
// day's activity. The day's view starts from the morning snapshot; this one
// starts days earlier, so what each coin held at the window's start is
// worked back from the snapshot: its quantity minus every move between the
// window's start and the snapshot. Pure.

import type { ActivityBase, ActivityLeg } from "./watchActivity.ts";

export const HISTORY_DAYS = [7, 30] as const;
export type HistoryDays = (typeof HISTORY_DAYS)[number];

/** Each coin's quantity at the window's start. Moves after the snapshot
 * aren't in it, so they're left out; never below zero (a coin moved in and
 * out entirely inside the window held none at its start). */
export function windowBase(
  snapshotQty: ReadonlyMap<string, { qty: number; kept: boolean }>,
  legs: readonly ActivityLeg[],
  snapshotAtMs: number,
  windowStartMs: number,
): Record<string, ActivityBase> {
  const moved = new Map<string, number>();
  for (const l of legs) {
    const t = Date.parse(l.at);
    if (t < windowStartMs || t > snapshotAtMs) continue;
    moved.set(l.assetKey, (moved.get(l.assetKey) ?? 0) + l.qtyDelta);
  }
  const base: Record<string, ActivityBase> = {};
  for (const l of legs) {
    if (base[l.assetKey]) continue;
    const s = snapshotQty.get(l.assetKey);
    base[l.assetKey] = { qty: Math.max(0, (s?.qty ?? 0) - (moved.get(l.assetKey) ?? 0)), kept: s?.kept ?? false };
  }
  return base;
}

// Stored history (owner 2026-09-29: "no different than logging it daily"):
// what a read found is kept on the watched address, so a later press — or
// anyone else watching the same wallet — reads only what's missing: newer
// transfers since the last read, older days when a longer window is asked
// for. Trades are one per transaction and coin, so overlaps never repeat.

/** Kept this long; older trades are dropped. */
export const HISTORY_KEEP_DAYS = 30;
/** A chain read this recently isn't read again for newer transfers. */
export const HISTORY_FRESH_MS = 15 * 60_000;

/** What has been read on one chain: from when to when, and the blocks at
 * each end (null: nothing was found there — re-reading it costs nothing). */
export interface ChainCoverage {
  from: string;
  to: string;
  fromBlock: string | null;
  toBlock: string | null;
}

export interface TradeHistory {
  legs: ActivityLeg[];
  coverage: Record<string, ChainCoverage>;
}

export type HistoryRead =
  | { chain: string; kind: "all" }
  /** Newer than the last read, from its newest block. */
  | { chain: string; kind: "newer"; fromBlock: string }
  /** Older than what's stored, up to its oldest block. */
  | { chain: string; kind: "older"; toBlock: string | null };

/** The reads a window needs, per chain, given what's stored. */
export function planHistoryReads(coverage: Readonly<Record<string, ChainCoverage>>, chains: readonly string[], startMs: number, nowMs: number): HistoryRead[] {
  const reads: HistoryRead[] = [];
  for (const chain of chains) {
    const c = coverage[chain];
    if (!c) {
      reads.push({ chain, kind: "all" });
      continue;
    }
    if (Date.parse(c.from) > startMs) reads.push({ chain, kind: "older", toBlock: c.fromBlock });
    if (nowMs - Date.parse(c.to) > HISTORY_FRESH_MS) {
      // Nothing found before: nothing to start from, and nothing to re-read.
      reads.push(c.toBlock ? { chain, kind: "newer", fromBlock: c.toBlock } : { chain, kind: "all" });
    }
  }
  return reads;
}

/** Stored legs plus new ones — one per transaction and coin — without
 * anything older than `keepFromMs`, oldest first. */
export function mergeHistoryLegs(stored: readonly ActivityLeg[], added: readonly ActivityLeg[], keepFromMs: number): ActivityLeg[] {
  const byId = new Map<string, ActivityLeg>();
  for (const l of [...stored, ...added]) {
    if (Date.parse(l.at) < keepFromMs) continue;
    const k = `${l.txId}|${l.assetKey}`;
    if (!byId.has(k)) byId.set(k, l);
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

const minBlock = (a: string | null, b: string | null) => (a && b ? (parseInt(a, 16) <= parseInt(b, 16) ? a : b) : (a ?? b));
const maxBlock = (a: string | null, b: string | null) => (a && b ? (parseInt(a, 16) >= parseInt(b, 16) ? a : b) : (a ?? b));

/** A chain's coverage after a read. `readFrom`: how far back the read got —
 * the window's start, or its oldest transfer when it stopped at the page cap. */
export function extendCoverage(
  prev: ChainCoverage | undefined,
  read: { kind: HistoryRead["kind"]; readFrom: string; readTo: string; oldestBlock: string | null; newestBlock: string | null },
  keepFromMs: number,
): ChainCoverage {
  const floor = new Date(keepFromMs).toISOString();
  const clamp = (iso: string) => (iso < floor ? floor : iso);
  if (!prev || read.kind === "all") {
    return { from: clamp(read.readFrom), to: read.readTo, fromBlock: read.oldestBlock, toBlock: read.newestBlock };
  }
  return read.kind === "older"
    ? { ...prev, from: clamp(read.readFrom < prev.from ? read.readFrom : prev.from), fromBlock: minBlock(read.oldestBlock, prev.fromBlock) }
    : { ...prev, to: read.readTo, toBlock: maxBlock(read.newestBlock, prev.toBlock), from: clamp(prev.from) };
}

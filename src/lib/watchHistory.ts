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

// Each watched position's life (docs/wallet-watch/PLAN.md, phase 2 — read by
// phase 3's track record): when it was first seen and at what price, and when
// it closed. Pure: turns one read's movements into row changes.
//
// A position already held on the first read is recorded as held_at_start:
// its real entry is unknown, and the first read's price is not claimed as
// one.

import type { AssetState, Movement } from "./watchDiff.ts";

/** Positions under this at the first read aren't worth tracking. */
export const TRACK_MIN_USD = 100;

export interface OpenPosition {
  assetKey: string;
  openedAt: string;
}

export interface PositionInsert {
  assetKey: string;
  openedAt: string;
  positionType: AssetState["type"];
  ticker: string;
  priceKey: string | null;
  heldAtStart: boolean;
  entryPrice: number | null;
  entryQty: number;
}

export interface PositionChanges {
  inserts: PositionInsert[];
  /** Open positions that closed at this read. */
  closes: { assetKey: string; openedAt: string; exitPrice: number | null }[];
  /** Open positions still held: their quantity now. */
  touches: { assetKey: string; openedAt: string; qty: number }[];
}

export function positionChanges(input: {
  firstRead: boolean;
  states: ReadonlyMap<string, AssetState>;
  movements: readonly Movement[];
  open: readonly OpenPosition[];
  now: string;
  priceOf: (asset: AssetState) => number | null;
}): PositionChanges {
  const { firstRead, states, movements, open, now, priceOf } = input;
  const openByKey = new Map(open.map((p) => [p.assetKey, p]));
  const out: PositionChanges = { inserts: [], closes: [], touches: [] };

  if (firstRead) {
    for (const s of states.values()) {
      const price = priceOf(s);
      if (openByKey.has(s.key) || s.qty <= 0 || price === null || s.qty * price < TRACK_MIN_USD) continue;
      out.inserts.push({ assetKey: s.key, openedAt: now, positionType: s.type, ticker: s.ticker, priceKey: s.priceKey, heldAtStart: true, entryPrice: price, entryQty: s.qty });
    }
    return out;
  }

  const moved = new Set<string>();
  for (const m of movements) {
    moved.add(m.assetKey);
    const current = openByKey.get(m.assetKey);
    if (m.kind === "new" && !current) {
      out.inserts.push({ assetKey: m.assetKey, openedAt: now, positionType: m.positionType, ticker: m.ticker, priceKey: m.priceKey, heldAtStart: false, entryPrice: m.priceUsd, entryQty: m.qtyAfter });
    } else if (m.kind === "exited" && current) {
      out.closes.push({ assetKey: m.assetKey, openedAt: current.openedAt, exitPrice: m.priceUsd });
    } else if (current) {
      out.touches.push({ assetKey: m.assetKey, openedAt: current.openedAt, qty: m.qtyAfter });
    }
  }
  // Still held without a movement: keep its last-seen current.
  for (const p of open) {
    if (moved.has(p.assetKey)) continue;
    const s = states.get(p.assetKey);
    if (s && s.qty > 0 && !s.kept) out.touches.push({ assetKey: p.assetKey, openedAt: p.openedAt, qty: s.qty });
  }
  return out;
}

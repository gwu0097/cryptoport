// Which rows of the day's activity fold together (Wallet Watch, owner
// 2026-09-28): for every trader alike, the coins they've completely sold out
// of become one summary row; open positions and their most recent coin keep
// their own rows, since those aren't finished. Pure.

export interface FoldCoin {
  influencerId: string;
  lastAt: string;
  sells: number;
  holdingQty: number;
  nowUsd: number | null;
}

/** Nothing left worth having: none held, or a leftover under $1 (the daily
 * read's rule for a closed position). */
export function soldOut(c: FoldCoin): boolean {
  if (c.sells === 0) return false;
  if (c.holdingQty <= 0) return true;
  return c.nowUsd !== null && c.holdingQty * c.nowUsd < 1;
}

export type FoldItem<C> = { kind: "coin"; c: C } | { kind: "group"; coins: C[] };

/** `sorted` in display order → rows: each trader's sold-out coins (two or
 * more, not counting their most recent coin) as one group placed where the
 * first of them was; everything else as itself. */
export function foldSoldOut<C extends FoldCoin>(sorted: readonly C[]): FoldItem<C>[] {
  const byTrader = new Map<string, C[]>();
  for (const c of sorted) byTrader.set(c.influencerId, [...(byTrader.get(c.influencerId) ?? []), c]);
  const folded = new Map<string, C[]>();
  for (const [id, mine] of byTrader) {
    const newest = mine.reduce((a, c) => (c.lastAt > a.lastAt ? c : a));
    const done = mine.filter((c) => c !== newest && soldOut(c));
    if (done.length >= 2) folded.set(id, done);
  }
  const placed = new Set<string>();
  const out: FoldItem<C>[] = [];
  for (const c of sorted) {
    const done = folded.get(c.influencerId);
    if (!done || !done.includes(c)) out.push({ kind: "coin", c });
    else if (!placed.has(c.influencerId)) {
      placed.add(c.influencerId);
      out.push({ kind: "group", coins: done });
    }
  }
  return out;
}

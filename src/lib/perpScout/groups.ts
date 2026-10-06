// Perp Scout's "Group by coin": the entries shown, one group per coin, so
// several traders in the same coin read at a glance. Pure.

export interface GroupInput {
  coin: string;
  address: string;
  side: "long" | "short";
  /** Current size in dollars; null = unknown (left out of the totals). */
  notionalUsd: number | null;
  entryPx: number | null;
  /** Size in the coin. */
  size: number;
  directional: boolean;
}

export interface CoinGroup<T> {
  coin: string;
  rows: T[];
  traders: number;
  longs: number;
  shorts: number;
  directional: number;
  notionalUsd: number;
  /** Size-weighted average entry when every position is on one side, else null
   * (an average across longs and shorts means nothing). */
  avgEntry: number | null;
}

/** Groups in order of how many traders hold the coin, then combined size;
 * rows keep the order they came in (the table's sort). */
export function groupByCoin<T>(rows: readonly T[], view: (row: T) => GroupInput): CoinGroup<T>[] {
  const byCoin = new Map<string, T[]>();
  for (const r of rows) {
    const coin = view(r).coin;
    byCoin.set(coin, [...(byCoin.get(coin) ?? []), r]);
  }
  const groups: CoinGroup<T>[] = [];
  for (const [coin, members] of byCoin) {
    const vs = members.map(view);
    const oneSide = vs.every((v) => v.side === vs[0].side);
    const priced = vs.filter((v) => v.entryPx !== null && v.size > 0);
    const qty = priced.reduce((s, v) => s + v.size, 0);
    groups.push({
      coin,
      rows: members,
      traders: new Set(vs.map((v) => v.address)).size,
      longs: vs.filter((v) => v.side === "long").length,
      shorts: vs.filter((v) => v.side === "short").length,
      directional: vs.filter((v) => v.directional).length,
      notionalUsd: vs.reduce((s, v) => s + (v.notionalUsd ?? 0), 0),
      avgEntry: oneSide && qty > 0 ? priced.reduce((s, v) => s + v.entryPx! * v.size, 0) / qty : null,
    });
  }
  return groups.sort((a, b) => b.traders - a.traders || b.notionalUsd - a.notionalUsd);
}

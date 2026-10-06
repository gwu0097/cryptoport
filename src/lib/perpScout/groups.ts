// Perp Scout's "Group by coin": the activity shown — open positions and
// recent closes — one group per coin, so several traders in the same coin
// read at a glance. Pure.

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
  /** A position closed in the window: counts toward the coin's traders and
   * its `closed` tally, never toward the open figures. */
  closed?: boolean;
  /** How many closes a closed row sums (1 when absent). */
  closes?: number;
}

export interface CoinGroup<T> {
  coin: string;
  rows: T[];
  /** Traders with a position open or closed in the coin. */
  traders: number;
  closed: number;
  longs: number;
  shorts: number;
  directional: number;
  notionalUsd: number;
  /** Size-weighted average entry when every position is on one side, else null
   * (an average across longs and shorts means nothing). */
  avgEntry: number | null;
}

/** Groups in order of how many traders hold the coin, then combined size —
 * or, with `order` "rows", by where each coin's first row came; rows keep the
 * order they came in (the table's sort). */
export function groupByCoin<T>(rows: readonly T[], view: (row: T) => GroupInput, order: "traders" | "rows" = "traders"): CoinGroup<T>[] {
  const byCoin = new Map<string, T[]>();
  for (const r of rows) {
    const coin = view(r).coin;
    byCoin.set(coin, [...(byCoin.get(coin) ?? []), r]);
  }
  const groups: CoinGroup<T>[] = [];
  for (const [coin, members] of byCoin) {
    const all = members.map(view);
    const vs = all.filter((v) => !v.closed);
    const oneSide = vs.length > 0 && vs.every((v) => v.side === vs[0].side);
    const priced = vs.filter((v) => v.entryPx !== null && v.size > 0);
    const qty = priced.reduce((s, v) => s + v.size, 0);
    groups.push({
      coin,
      rows: members,
      traders: new Set(all.map((v) => v.address)).size,
      closed: all.filter((v) => v.closed).reduce((n, v) => n + (v.closes ?? 1), 0),
      longs: vs.filter((v) => v.side === "long").length,
      shorts: vs.filter((v) => v.side === "short").length,
      directional: vs.filter((v) => v.directional).length,
      notionalUsd: vs.reduce((s, v) => s + (v.notionalUsd ?? 0), 0),
      avgEntry: oneSide && qty > 0 ? priced.reduce((s, v) => s + v.entryPx! * v.size, 0) / qty : null,
    });
  }
  // "rows": in the order the rows came (the Map keeps first appearance) — a
  // sorted table places each coin by its top row, so sorting by Opened puts
  // the coin opened most recently first (owner 2026-10-06: HYPE stayed above
  // BTC whatever the sort).
  if (order === "rows") return groups;
  return groups.sort((a, b) => b.traders - a.traders || b.notionalUsd - a.notionalUsd);
}

// A liquid staking token's 24h change that can't be right (owner 2026-10-08):
// INF (Sanctum's staked SOL) showed +11.29% on CoinGecko while SOL and every
// other staked SOL were −6.7%, and topped the Dashboard's gainers — Jupiter
// had it at −7.43%. A staked token tracks its base coin within a fraction of
// a point a day (it's the base coin plus slowly accruing yield), so one far
// from it is a bad print on a thin market, not a move. Pure.
//
// Such a change is unknown, shown "—" (CLAUDE.md §4.1), never replaced with
// a guess. Compared with the base coin's own change when that's among the
// prices read (the largest-market-cap coin with the base symbol), else the
// median of the staked tokens of the same base (at least three, so one bad
// print can't move it).

import type { LiquidStakingToken } from "./liquidStaking.ts";

/** Farther than this (percentage points) from the base coin's 24h change. */
export const MAX_GAP_POINTS = 5;

export interface ChangeRow {
  key: string;
  symbol: string | null;
  change: number | null;
  marketCap: number | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The keys whose change should be treated as unknown. */
export function implausibleStakedChanges(rows: readonly ChangeRow[], tokens: readonly LiquidStakingToken[]): Set<string> {
  const baseOf = new Map(tokens.filter((t) => t.baseSymbol).map((t) => [t.coingeckoId, t.baseSymbol!.toUpperCase()]));
  const staked = rows.filter((r) => baseOf.has(r.key) && r.change !== null && Number.isFinite(r.change));
  if (staked.length === 0) return new Set();
  // The base coin: the biggest coin by market cap with that symbol that
  // isn't itself a staking token.
  const baseChange = new Map<string, number>();
  const bestCap = new Map<string, number>();
  for (const r of rows) {
    const sym = r.symbol?.toUpperCase();
    if (!sym || baseOf.has(r.key) || r.change === null || !Number.isFinite(r.change)) continue;
    const cap = r.marketCap ?? 0;
    if (cap > (bestCap.get(sym) ?? -1)) {
      bestCap.set(sym, cap);
      baseChange.set(sym, r.change);
    }
  }
  const out = new Set<string>();
  for (const r of staked) {
    const base = baseOf.get(r.key)!;
    let ref = baseChange.get(base);
    if (ref === undefined) {
      // The median of every staked token of this base, this one included:
      // with three or more, one bad print can't move it.
      const all = staked.filter((p) => baseOf.get(p.key) === base).map((p) => p.change!);
      if (all.length < 3) continue;
      ref = median(all);
    }
    if (Math.abs(r.change! - ref) > MAX_GAP_POINTS) out.add(r.key);
  }
  return out;
}

// Perp Scout's trader screen, pure (docs/perp-scout/PLAN.md). Three stages:
//  1. the Hyperliquid leaderboard (every account's value and PnL / ROI /
//     volume per window): sized, profitable, profitable this month, and not
//     a market maker or high-frequency account;
//  2. a review set from those: half the largest all-time earners, half the
//     best all-time ROI — so the shortlist isn't only whales;
//  3. each reviewed account's own PnL curve (portfolio.ts): long enough,
//     drawdown no bigger than its typical equity, not one lucky month.
// The passers are ranked by return ÷ drawdown and the top N are followed.

import type { TraderStats } from "./portfolio.ts";

export interface WindowPerf {
  pnl: number;
  /** A fraction: 0.5 = +50%. */
  roi: number;
  vlm: number;
}

export interface LeaderboardRow {
  address: string;
  displayName: string | null;
  accountValue: number;
  day: WindowPerf;
  week: WindowPerf;
  month: WindowPerf;
  allTime: WindowPerf;
}

export const STAGE1 = {
  minEquity: 50_000,
  maxEquity: 20_000_000,
  minAllTimePnl: 100_000,
  minAllTimeRoi: 0.5,
  /** Monthly volume over account value: above it, a market maker or HFT. */
  maxMonthlyTurnover: 60,
} as const;

export const STAGE3 = {
  minWeeks: 26,
  /** Max drawdown of the PnL curve ÷ typical equity. */
  maxDrawdownShare: 1,
  /** Share of all profit made in the best 4 weeks. */
  maxBestFourShare: 0.8,
} as const;

const num = (x: unknown): number => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN);

function perf(windows: Map<string, unknown>, name: string): WindowPerf | null {
  const w = windows.get(name) as { pnl?: unknown; roi?: unknown; vlm?: unknown } | undefined;
  if (!w) return null;
  const p = { pnl: num(w.pnl), roi: num(w.roi), vlm: num(w.vlm) };
  return Number.isFinite(p.pnl) && Number.isFinite(p.roi) && Number.isFinite(p.vlm) ? p : null;
}

/** The leaderboard file (`{leaderboardRows: [...]}`). Rows missing a window
 * are left out; a file with no usable row at all is an error (its shape
 * changed), never an empty leaderboard. */
export function parseLeaderboard(json: unknown): LeaderboardRow[] {
  const rows = (json as { leaderboardRows?: unknown })?.leaderboardRows;
  if (!Array.isArray(rows)) throw new Error("Hyperliquid leaderboard: no leaderboardRows in the answer");
  const out: LeaderboardRow[] = [];
  for (const r of rows as { ethAddress?: unknown; accountValue?: unknown; displayName?: unknown; windowPerformances?: unknown }[]) {
    if (typeof r?.ethAddress !== "string" || !Array.isArray(r.windowPerformances)) continue;
    const windows = new Map((r.windowPerformances as [string, unknown][]).filter((w) => Array.isArray(w)).map(([k, v]) => [k, v]));
    const day = perf(windows, "day");
    const week = perf(windows, "week");
    const month = perf(windows, "month");
    const allTime = perf(windows, "allTime");
    const accountValue = num(r.accountValue);
    if (!day || !week || !month || !allTime || !Number.isFinite(accountValue)) continue;
    out.push({
      address: r.ethAddress.toLowerCase(),
      displayName: typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim() : null,
      accountValue,
      day,
      week,
      month,
      allTime,
    });
  }
  if (rows.length > 0 && out.length === 0) throw new Error("Hyperliquid leaderboard: no row in the expected shape");
  return out;
}

/** Stage 1: sized, profitable all-time and this month, not a market maker. */
export function passesStage1(r: LeaderboardRow): boolean {
  return (
    r.accountValue >= STAGE1.minEquity &&
    r.accountValue <= STAGE1.maxEquity &&
    r.allTime.pnl >= STAGE1.minAllTimePnl &&
    r.allTime.roi >= STAGE1.minAllTimeRoi &&
    r.month.pnl > 0 &&
    r.month.vlm <= STAGE1.maxMonthlyTurnover * r.accountValue
  );
}

/** Stage 2: `n` accounts to review — the top by all-time PnL and the top by
 * all-time ROI, alternating, without repeats. */
export function pickForReview(rows: readonly LeaderboardRow[], n: number): LeaderboardRow[] {
  const byPnl = [...rows].sort((a, b) => b.allTime.pnl - a.allTime.pnl);
  const byRoi = [...rows].sort((a, b) => b.allTime.roi - a.allTime.roi);
  const picked = new Map<string, LeaderboardRow>();
  for (let i = 0; picked.size < n && (i < byPnl.length || i < byRoi.length); i++) {
    for (const r of [byPnl[i], byRoi[i]]) if (r && picked.size < n && !picked.has(r.address)) picked.set(r.address, r);
  }
  return [...picked.values()];
}

/** Stage 3: why an account's own history fails, or [] when it passes. */
export function stage3Failures(s: TraderStats): string[] {
  const why: string[] = [];
  if (s.historyWeeks < STAGE3.minWeeks) why.push(`${s.historyWeeks} weeks of history (< ${STAGE3.minWeeks})`);
  if (s.drawdownShare === null) why.push("no typical equity to measure drawdown against");
  else if (s.drawdownShare > STAGE3.maxDrawdownShare) why.push(`max drawdown ${(s.drawdownShare * 100).toFixed(0)}% of equity`);
  if (s.bestFourShare === null) why.push("no net profit on its PnL curve");
  else if (s.bestFourShare > STAGE3.maxBestFourShare) why.push(`${(s.bestFourShare * 100).toFixed(0)}% of profit in its best 4 weeks`);
  return why;
}

/** The ranking: yearly return on typical equity ÷ max drawdown share
 * (Calmar-style), the drawdown floored at 10% so a short calm record can't
 * score infinitely. Null when either is unknown. */
export function traderScore(s: TraderStats): number | null {
  if (s.yearlyReturn === null || s.drawdownShare === null) return null;
  return s.yearlyReturn / Math.max(s.drawdownShare, 0.1);
}

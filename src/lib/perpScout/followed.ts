// The traders Perp Scout follows — curated in chat with the owner (owner
// 2026-10-06: "I'm asking you to find them for me, then just add it to the
// list"). New ones are found with `scripts/diag/perp-scout-screen.mts` (the
// screen in screen.ts / portfolio.ts); each entry keeps the figures it was
// picked on and why, so the list explains itself. Scan reads only these.
// Figures are a snapshot from the day picked (stale after), null = not
// measured. Pure.

export interface FollowedTrader {
  /** Lowercase. */
  address: string;
  name: string;
  /** YYYY-MM-DD it was added. */
  addedOn: string;
  /** Why it's on the list, in a line. */
  why: string;
  /** Its figures when picked. */
  picked: {
    /** YYYY-MM-DD the figures are from. */
    asOf: string;
    equity: number | null;
    allTimePnl: number | null;
    monthPnl: number | null;
    historyMonths: number | null;
    /** Weeks with a gain ÷ weeks with any change. */
    winningWeeks: number | null;
    /** Max drawdown of the PnL curve ÷ typical equity. */
    drawdownShare: number | null;
    /** Share of all profit made in the best 4 weeks. */
    bestFourShare: number | null;
  };
}

// The sol-bot handoff's shortlist (2026-10-05): the 8 of the 60 largest
// all-time earners that passed its stage 3 (≥ 26 weeks, drawdown ≤ typical
// equity, best 4 weeks ≤ 80% of profit, leverage ≤ 10×). Mostly whales with
// hedged books — see docs/perp-scout/PLAN.md.
const HANDOFF = (n: number, why: string) => `Handoff #${n}: ${why}`;

export const FOLLOWED: readonly FollowedTrader[] = [
  {
    address: "0x0748e296e5a350ec36c8487a1cea406e1b57d4b2",
    name: "Hedged macro (#1)",
    addedOn: "2026-10-06",
    why: HANDOFF(1, "most consistent; hedged long/short alt book, holds ~29 h, exits by hand, almost no stops"),
    picked: { asOf: "2026-10-05", equity: 6.1e6, allTimePnl: 12.9e6, monthPnl: 1.41e6, historyMonths: 17, winningWeeks: 0.65, drawdownShare: 0.85, bestFourShare: 0.63 },
  },
  {
    address: "0x015354106478dda69c4aae3c0cf801290b738052",
    name: "Low-leverage (#2)",
    addedOn: "2026-10-06",
    why: HANDOFF(2, "safest profile: lowest drawdown, 0.6× leverage"),
    picked: { asOf: "2026-10-05", equity: 11.9e6, allTimePnl: 11.9e6, monthPnl: 0.95e6, historyMonths: 19, winningWeeks: 0.52, drawdownShare: 0.33, bestFourShare: 0.53 },
  },
  {
    address: "0x5f94a51948d2376ad34a6fadfa2544e651b74b96",
    name: "Longest record (#3)",
    addedOn: "2026-10-06",
    why: HANDOFF(3, "longest record (22 months), 5.4× leverage"),
    picked: { asOf: "2026-10-05", equity: 18.3e6, allTimePnl: 17.3e6, monthPnl: 2.61e6, historyMonths: 22, winningWeeks: 0.53, drawdownShare: 0.59, bestFourShare: 0.59 },
  },
  {
    address: "0xd14d535a383b065cf2228963a984d0e2477bee1f",
    name: "8-hour holder (#4)",
    addedOn: "2026-10-06",
    why: HANDOFF(4, "holds ~8 h; drawdown near equity, 80% of profit in 4 weeks (at the limit)"),
    picked: { asOf: "2026-10-05", equity: 13.7e6, allTimePnl: 11.5e6, monthPnl: 1.21e6, historyMonths: 14, winningWeeks: 0.61, drawdownShare: 0.95, bestFourShare: 0.8 },
  },
  {
    address: "0x807a2e2e469df84b299da5f90f15dda4380daca1",
    name: "Top earner (#5)",
    addedOn: "2026-10-06",
    why: HANDOFF(5, "largest all-time PnL ($35.6M) on $12.9M"),
    picked: { asOf: "2026-10-05", equity: 12.9e6, allTimePnl: 35.6e6, monthPnl: 1.49e6, historyMonths: 22, winningWeeks: 0.54, drawdownShare: 0.89, bestFourShare: 0.65 },
  },
  {
    address: "0x051c2e6d49cf82ebc47f08f9b85800f94fc9693c",
    name: "Hot month (#6)",
    addedOn: "2026-10-06",
    why: HANDOFF(6, "best 30 days (+$5.2M), 7.1× leverage"),
    picked: { asOf: "2026-10-05", equity: 16.1e6, allTimePnl: 15.3e6, monthPnl: 5.22e6, historyMonths: 19, winningWeeks: 0.5, drawdownShare: 0.81, bestFourShare: 0.6 },
  },
  {
    address: "0x192bb1fdb08a197e1cdebcfc52deee92e5e33e1d",
    name: "Smaller whale (#7)",
    addedOn: "2026-10-06",
    why: HANDOFF(7, "smallest account of the 8; 79% of profit in 4 weeks"),
    picked: { asOf: "2026-10-05", equity: 5.8e6, allTimePnl: 10.5e6, monthPnl: 0.5e6, historyMonths: 19, winningWeeks: 0.54, drawdownShare: 0.82, bestFourShare: 0.79 },
  },
  {
    address: "0x462e3f2ce774b4dbba10662a2155e4823d4c820f",
    name: "Steady whale (#8)",
    addedOn: "2026-10-06",
    why: HANDOFF(8, "22-month record; drawdown 93% of equity"),
    picked: { asOf: "2026-10-05", equity: 16.9e6, allTimePnl: 17.8e6, monthPnl: 1.64e6, historyMonths: 22, winningWeeks: 0.51, drawdownShare: 0.93, bestFourShare: 0.69 },
  },
];

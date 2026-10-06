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
    /** The account's median value over its history (what all-time % is
     * measured on); absent on entries picked before it was kept. */
    typicalEquity?: number | null;
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

// Seeded 2026-10-06 from the sol-bot handoff's shortlist (its stage 3 on the
// 60 largest all-time earners; figures 2026-10-05). Re-checked on the perps
// record that day: #4, #5, #7 and #8 were dropped — no perp positions, and
// little or no perps profit (#8's $17.8M was spot gains, no perp trade ever).
// #6 kept on the owner's call though 87% of its profit came in 4 weeks.
// Then the fixed screen's picks (docs/perp-scout/PLAN.md, "Finding traders").
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
    address: "0x051c2e6d49cf82ebc47f08f9b85800f94fc9693c",
    name: "Hot month (#6)",
    addedOn: "2026-10-06",
    why: HANDOFF(6, "best 30 days (+$5.2M), 7.1× leverage"),
    picked: { asOf: "2026-10-05", equity: 16.1e6, allTimePnl: 15.3e6, monthPnl: 5.22e6, historyMonths: 19, winningWeeks: 0.5, drawdownShare: 0.81, bestFourShare: 0.6 },
  },
  {
    address: "0x8bae3527e5a33fa0cf184f37bc112d071463ab6d",
    name: "Calm swing (0x8bae)",
    addedOn: "2026-10-06",
    why: "Screen 2026-10-06: best score of the 2026-10-06 screen: 75% winning weeks, 13% drawdown, slow (~6× turnover a month)",
    picked: { asOf: "2026-10-06", equity: 4623663, allTimePnl: 11510028, monthPnl: 156384, historyMonths: 14, winningWeeks: 0.75, drawdownShare: 0.13, bestFourShare: 0.33 },
  },
  {
    address: "0x16bf84af3f85f8c8a97597bf2be549dfe0dee637",
    name: "Low drawdown (0x16bf)",
    addedOn: "2026-10-06",
    why: "Screen 2026-10-06: 5% drawdown on $9M, slow (~5× a month); 79% of profit in 4 weeks (near the limit)",
    picked: { asOf: "2026-10-06", equity: 9090146, allTimePnl: 5739262, monthPnl: 84925, historyMonths: 11, winningWeeks: 0.59, drawdownShare: 0.05, bestFourShare: 0.79 },
  },
  {
    address: "0xf97ad6704baec104d00b88e0c157e2b7b3a1ddd1",
    name: "Directional majors (0xf97a)",
    addedOn: "2026-10-06",
    why: "Screen 2026-10-06: 82% winning weeks, 17% drawdown over 28 months; long BTC/ETH/SOL when picked",
    picked: { asOf: "2026-10-06", equity: 646849, allTimePnl: 1631809, monthPnl: 75096, historyMonths: 28, winningWeeks: 0.82, drawdownShare: 0.17, bestFourShare: 0.28 },
  },
  {
    address: "0x166866a2845506f6b4c817482fe53b4985882ea6",
    name: "Patient (0x1668)",
    addedOn: "2026-10-06",
    why: "Screen 2026-10-06: 17% drawdown over 29 months, slow (~6× a month)",
    picked: { asOf: "2026-10-06", equity: 1567821, allTimePnl: 395800, monthPnl: 38703, historyMonths: 29, winningWeeks: 0.67, drawdownShare: 0.17, bestFourShare: 0.72 },
  },
  {
    address: "0x5cbdb794b3b36df58a7ce6c1a552f117f061103b",
    name: "Directional (0x5cbd)",
    addedOn: "2026-10-06",
    why: "Screen 2026-10-06: 29 months, 30% drawdown; one directional position at a time when picked",
    picked: { asOf: "2026-10-06", equity: 759943, allTimePnl: 491942, monthPnl: 342867, historyMonths: 29, winningWeeks: 0.53, drawdownShare: 0.3, bestFourShare: 0.79 },
  },
  {
    address: "0xa5fd942d4badbab4fe84a9e10f565dd40d5f15ff",
    name: "Long-biased book (0xa5fd)",
    addedOn: "2026-10-06",
    why: "Screen 2026-10-06: 70% winning weeks over 29 months; long-biased book of ~34 positions",
    picked: { asOf: "2026-10-06", equity: 2574968, allTimePnl: 2258990, monthPnl: 472851, historyMonths: 29, winningWeeks: 0.7, drawdownShare: 0.48, bestFourShare: 0.44 },
  },
  {
    address: "0x7c9063122c01837fe83da2521056e10c9b6dd129",
    name: "Riskier swing (0x7c90)",
    addedOn: "2026-10-06",
    why: "Screen 2026-10-06: 73% winning weeks, but 74% drawdown; long WLD when picked",
    picked: { asOf: "2026-10-06", equity: 568314, allTimePnl: 1818011, monthPnl: 674142, historyMonths: 11, winningWeeks: 0.73, drawdownShare: 0.74, bestFourShare: 0.68 },
  },
];

/** Most traders a scan reads (the code list and those added on the page). */
export const MAX_FOLLOWED = 40;

export const isTraderAddress = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

/** The list a scan reads: the code list, then traders added on the page that
 * aren't already on it, less any the owner removed on the page. */
export function mergeFollowed(code: readonly FollowedTrader[], added: readonly FollowedTrader[], removed: readonly string[] = []): FollowedTrader[] {
  const listed = new Set(code.map((f) => f.address));
  const gone = new Set(removed);
  return [...code, ...added.filter((f) => !listed.has(f.address))].filter((f) => !gone.has(f.address));
}

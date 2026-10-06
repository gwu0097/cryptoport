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
// Then the fixed screen's picks (docs/perp-scout/PLAN.md, "Finding traders"),
// and the swing screen's (--swing: 2-150 orders a week, a 2 h-21 d median
// hold; owner 2026-10-06: "swing traders, not a super long book").
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
  {
    address: "0xf53cab0c6f25f48f985d1e2c40e03fc7c1963364",
    name: "Swing f53c (7 d holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06: +372% 12 mo, +39% 30 d; 40 orders a week, median hold 7 d; drawdown 79%",
    picked: { asOf: "2026-10-06", equity: 806869, typicalEquity: 182697, allTimePnl: 1098788, monthPnl: 312589, historyMonths: 29, winningWeeks: 0.59, drawdownShare: 0.79, bestFourShare: 0.68 },
  },
  {
    address: "0xf00eabc409c51cf884ec7861cb839524af6afe3d",
    name: "Swing f00e (31 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06: +254% 12 mo, +53% 30 d; 13 orders a week, median hold 31 h; drawdown 74%",
    picked: { asOf: "2026-10-06", equity: 422784, typicalEquity: 268316, allTimePnl: 691762, monthPnl: 224905, historyMonths: 13, winningWeeks: 0.68, drawdownShare: 0.74, bestFourShare: 0.74 },
  },
  {
    address: "0x04a97ae7f350a22cd0cdb6b1875e8905b76495aa",
    name: "Swing 04a9 (20 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06: +174% 12 mo, +36% 30 d; 13 orders a week, median hold 20 h; drawdown 81%",
    picked: { asOf: "2026-10-06", equity: 686915, typicalEquity: 350764, allTimePnl: 610860, monthPnl: 247020, historyMonths: 8, winningWeeks: 0.76, drawdownShare: 0.81, bestFourShare: 0.74 },
  },
  {
    address: "0x95da8596c44dd09f4b8becce87ad3b7894fb2328",
    name: "Swing 95da (15 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06: +100% 12 mo, +12% 30 d; 88 orders a week, median hold 15 h; drawdown 20%",
    picked: { asOf: "2026-10-06", equity: 1930057, typicalEquity: 1092721, allTimePnl: 1096052, monthPnl: 222751, historyMonths: 7, winningWeeks: 0.75, drawdownShare: 0.2, bestFourShare: 0.76 },
  },
  {
    address: "0x2312171890250347dbf1b082bdf7950504909e92",
    name: "Swing 2312 (48 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06: +92% 12 mo, +10% 30 d; 12 orders a week, median hold 48 h; drawdown 25%",
    picked: { asOf: "2026-10-06", equity: 667286, typicalEquity: 429998, allTimePnl: 952134, monthPnl: 64137, historyMonths: 29, winningWeeks: 0.7, drawdownShare: 0.25, bestFourShare: 0.48 },
  },
  {
    address: "0x352deb23bebae8b4c57d0ae341d9c1951fd8425a",
    name: "Swing 352d (24 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06: +79% 12 mo, +14% 30 d; 10 orders a week, median hold 24 h; drawdown 19%",
    picked: { asOf: "2026-10-06", equity: 1254288, typicalEquity: 318526, allTimePnl: 341696, monthPnl: 176005, historyMonths: 29, winningWeeks: 0.57, drawdownShare: 0.19, bestFourShare: 0.53 },
  },
  {
    address: "0x6a02aedceac5a6813d960e4dae1910d9c458e77c",
    name: "Swing 6a02 (17 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06 (batch 2): +160% 12 mo, +18% 30 d; 19 orders a week, median hold 17 h; drawdown 36%",
    picked: { asOf: "2026-10-06", equity: 1142882, typicalEquity: 867501, allTimePnl: 1391105, monthPnl: 210579, historyMonths: 7, winningWeeks: 0.69, drawdownShare: 0.36, bestFourShare: 0.73 },
  },
  {
    address: "0xcb34e4bd8c63064d94f5d752ceaf9355aa070b1c",
    name: "Swing cb34 (2 d holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06 (batch 2): +93% 12 mo, +25% 30 d; 12 orders a week, median hold 2 d; drawdown 23%",
    picked: { asOf: "2026-10-06", equity: 345790, typicalEquity: 182381, allTimePnl: 170099, monthPnl: 85164, historyMonths: 15, winningWeeks: 0.69, drawdownShare: 0.23, bestFourShare: 0.78 },
  },
  {
    address: "0x69b05701f8175c276ecd0138387a197948e240bb",
    name: "Swing 69b0 (2 d holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06 (batch 2): +79% 12 mo, +9% 30 d; 8 orders a week, median hold 2 d; drawdown 19%",
    picked: { asOf: "2026-10-06", equity: 761390, typicalEquity: 561987, allTimePnl: 691479, monthPnl: 67783, historyMonths: 16, winningWeeks: 0.56, drawdownShare: 0.19, bestFourShare: 0.55 },
  },
  {
    address: "0x413c7a0a3489563350219bc96965a7da02f0fffc",
    name: "Swing 413c (5 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06 (batch 2): +61% 12 mo, +17% 30 d; 28 orders a week, median hold 5 h; drawdown 46%",
    picked: { asOf: "2026-10-06", equity: 878410, typicalEquity: 491552, allTimePnl: 1243840, monthPnl: 150201, historyMonths: 21, winningWeeks: 0.59, drawdownShare: 0.46, bestFourShare: 0.52 },
  },
  {
    address: "0x5b236d19f680ff47e7bf2a9eb88fc5cc03d443a8",
    name: "Swing 5b23 (12 h holds)",
    addedOn: "2026-10-06",
    why: "Swing screen 2026-10-06 (batch 2): +309% 12 mo, +6% 30 d; 6 orders a week, median hold 12 h; drawdown 45%",
    picked: { asOf: "2026-10-06", equity: 118982, typicalEquity: 67506, allTimePnl: 248284, monthPnl: 6714, historyMonths: 29, winningWeeks: 0.65, drawdownShare: 0.45, bestFourShare: 0.69 },
  },
];

/** Most traders a scan reads (the code list and those added on the page). */
export const MAX_FOLLOWED = 40;

export const isTraderAddress = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

/** The list a scan reads: the code list, then traders added on the page that
 * aren't already on it, less any the owner removed on the page, each under
 * the name the owner gave it on the page (`names`) when there is one. */
export function mergeFollowed(code: readonly FollowedTrader[], added: readonly FollowedTrader[], removed: readonly string[] = [], names: Readonly<Record<string, string>> = {}): FollowedTrader[] {
  const listed = new Set(code.map((f) => f.address));
  const gone = new Set(removed);
  return [...code, ...added.filter((f) => !listed.has(f.address))]
    .filter((f) => !gone.has(f.address))
    .map((f) => (names[f.address] ? { ...f, name: names[f.address] } : f));
}

// An influencer's trading record (Wallet Watch): profit and loss from
// Solana Tracker's PnL API, in USD, stored per address on
// watched_addresses.trading_record and summarized here. Pure.
//
// Two requests per address (adapters/solanaTracker.ts): the all-time summary
// and the past year day by day — every window below (30/90 days, months) is
// computed from those days, so it costs nothing more. Owner 2026-09-28: the
// point is whether a trader is profitable all year or only in a streak, so
// the record leads with months and how concentrated the profit is.

export interface StoredTradingRecord {
  /** All time, from the summary. */
  realizedUsd: number;
  unrealizedUsd: number;
  investedUsd: number;
  proceedsUsd: number;
  closedTokens: number;
  winningTokens: number;
  losingTokens: number;
  /** Closed coins by return: ">500%", "200-500%", … with their counts. */
  distribution: { range: string; count: number }[];
  avgHoldSecs: number | null;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  /** The past year, one entry per active day: [YYYY-MM-DD, realized USD, trades]. */
  days: [string, number, number][];
  /** Largest decline from a peak over the year, in USD and %. */
  drawdownUsd: number | null;
  drawdownPct: number | null;
}

export interface TradingSummary {
  addresses: number;
  allTime: { totalUsd: number; realizedUsd: number; unrealizedUsd: number; roiPct: number | null; winRatePct: number | null; closed: number; wins: number; avgHoldSecs: number | null; since: string | null };
  distribution: { range: string; count: number }[];
  months: { month: string; realizedUsd: number; trades: number }[];
  yearUsd: number;
  last90Usd: number;
  last30Usd: number;
  profitableMonths: number;
  activeMonths: number;
  /** Share of the year's profit from its best month / best day (null when the year isn't up). */
  bestMonthShare: number | null;
  bestDay: { date: string; realizedUsd: number } | null;
  bestDayShare: number | null;
  drawdownUsd: number | null;
  drawdownPct: number | null;
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** One influencer's addresses' records combined, and the windows and
 * consistency figures from them. `today` is YYYY-MM-DD (UTC). */
export function summarizeTrading(records: readonly StoredTradingRecord[], today: string): TradingSummary | null {
  if (records.length === 0) return null;
  const sum = (f: (r: StoredTradingRecord) => number) => records.reduce((s, r) => s + f(r), 0);
  const invested = sum((r) => r.investedUsd);
  const closed = sum((r) => r.closedTokens);
  const wins = sum((r) => r.winningTokens);
  const holds = records.filter((r) => r.avgHoldSecs !== null);
  const dist = new Map<string, number>();
  for (const r of records) for (const d of r.distribution) dist.set(d.range, (dist.get(d.range) ?? 0) + d.count);

  // Days summed across addresses, then months.
  const byDay = new Map<string, { usd: number; trades: number }>();
  for (const r of records) {
    for (const [date, usd, trades] of r.days) {
      const cur = byDay.get(date) ?? { usd: 0, trades: 0 };
      cur.usd += usd;
      cur.trades += trades;
      byDay.set(date, cur);
    }
  }
  const byMonth = new Map<string, { realizedUsd: number; trades: number }>();
  for (const [date, d] of byDay) {
    const m = byMonth.get(date.slice(0, 7)) ?? { realizedUsd: 0, trades: 0 };
    m.realizedUsd += d.usd;
    m.trades += d.trades;
    byMonth.set(date.slice(0, 7), m);
  }
  const months = [...byMonth].map(([month, m]) => ({ month, ...m })).sort((a, b) => a.month.localeCompare(b.month));
  const since = (days: number) => [...byDay].filter(([date]) => date > addDays(today, -days)).reduce((s, [, d]) => s + d.usd, 0);
  const yearUsd = [...byDay.values()].reduce((s, d) => s + d.usd, 0);
  const bestMonth = months.reduce((b, m) => (m.realizedUsd > b ? m.realizedUsd : b), -Infinity);
  const best = [...byDay].sort((a, b) => b[1].usd - a[1].usd)[0];
  const firsts = records.map((r) => r.firstTradeAt).filter((t): t is string => !!t).sort();
  // One address's drawdown is exact; several can't be combined without their series.
  const one = records.length === 1 ? records[0] : null;

  return {
    addresses: records.length,
    allTime: {
      totalUsd: sum((r) => r.realizedUsd + r.unrealizedUsd),
      realizedUsd: sum((r) => r.realizedUsd),
      unrealizedUsd: sum((r) => r.unrealizedUsd),
      roiPct: invested > 0 ? ((sum((r) => r.proceedsUsd) - invested) / invested) * 100 : null,
      winRatePct: closed > 0 ? (wins / closed) * 100 : null,
      closed,
      wins,
      avgHoldSecs: holds.length > 0 ? holds.reduce((s, r) => s + r.avgHoldSecs!, 0) / holds.length : null,
      since: firsts[0] ?? null,
    },
    distribution: [...dist].map(([range, count]) => ({ range, count })),
    months,
    yearUsd,
    last90Usd: since(90),
    last30Usd: since(30),
    profitableMonths: months.filter((m) => m.realizedUsd > 0).length,
    activeMonths: months.length,
    bestMonthShare: yearUsd > 0 && months.length > 0 ? bestMonth / yearUsd : null,
    bestDay: best ? { date: best[0], realizedUsd: best[1].usd } : null,
    bestDayShare: yearUsd > 0 && best ? best[1].usd / yearUsd : null,
    drawdownUsd: one?.drawdownUsd ?? null,
    drawdownPct: one?.drawdownPct ?? null,
  };
}

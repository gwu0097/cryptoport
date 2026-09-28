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
  /** Each coin traded in the past 12 months (Solana Tracker's positions),
   * so a month's bar can list its coins. Built once, then only newer coins
   * are fetched: `cursor` is the newest last-trade time seen (ms). */
  coins?: { cursor: number | null; index: Record<string, CoinEntry> };
}

/** A coin's result: [month it was last sold (YYYY-MM), realized USD, return %, ticker]. */
export type CoinEntry = [string, number, number | null, string];

/** One coin as the positions endpoint returns it (the adapter's shape). */
export interface FetchedCoin {
  mint: string;
  symbol: string;
  realizedUsd: number;
  roiPct: number | null;
  lastSellMs: number | null;
  lastTradeMs: number;
}

export interface CoinBrief {
  mint: string;
  symbol: string;
  pnlUsd: number;
  roiPct: number | null;
}

export interface MonthCoins {
  count: number;
  wins: number;
  top: CoinBrief[];
  bottom: CoinBrief[];
}

const MONTH_TOP = 5;
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** The coin index after a load: previous entries, then the fetched ones
 * (a coin traded again moves to its new month — counted once), coins not
 * yet sold skipped, and anything older than 12 months dropped. */
export function mergeCoins(prev: StoredTradingRecord["coins"] | undefined, fetched: readonly FetchedCoin[], nowMs: number): NonNullable<StoredTradingRecord["coins"]> {
  const index: Record<string, CoinEntry> = { ...(prev?.index ?? {}) };
  let cursor = prev?.cursor ?? null;
  for (const c of fetched) {
    cursor = cursor === null ? c.lastTradeMs : Math.max(cursor, c.lastTradeMs);
    if (c.lastSellMs === null) continue; // still held: nothing realized yet
    index[c.mint] = [monthOf(c.lastSellMs), Math.round(c.realizedUsd * 100) / 100, c.roiPct === null ? null : Math.round(c.roiPct * 10) / 10, c.symbol];
  }
  const oldest = monthOf(nowMs - 365 * 24 * 60 * 60 * 1000);
  for (const [mint, e] of Object.entries(index)) if (e[0] < oldest) delete index[mint];
  return { cursor, index };
}

/** A month's coins across records: how many, how many won, and the biggest
 * gains and losses (with the mint, for the copy button). */
export function coinsByMonth(records: readonly StoredTradingRecord[]): Record<string, MonthCoins> {
  const by = new Map<string, CoinBrief[]>();
  for (const r of records) {
    for (const [mint, [month, pnlUsd, roiPct, symbol]] of Object.entries(r.coins?.index ?? {})) {
      by.set(month, [...(by.get(month) ?? []), { mint, symbol, pnlUsd, roiPct }]);
    }
  }
  const out: Record<string, MonthCoins> = {};
  for (const [month, coins] of by) {
    const sorted = [...coins].sort((a, b) => b.pnlUsd - a.pnlUsd);
    out[month] = {
      count: coins.length,
      wins: coins.filter((c) => c.pnlUsd > 0).length,
      top: sorted.filter((c) => c.pnlUsd > 0).slice(0, MONTH_TOP),
      bottom: sorted.filter((c) => c.pnlUsd < 0).reverse().slice(0, MONTH_TOP),
    };
  }
  return out;
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
  /** Per month: the coins sold in it (when the coin list is loaded). */
  monthCoins: Record<string, MonthCoins>;
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
    monthCoins: coinsByMonth(records),
  };
}

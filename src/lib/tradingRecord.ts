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
  /** An EVM address's record comes from Zerion (owner 2026-09-30): its
   * realized profit per month (YYYY-MM → [realized USD, USD put in, 1 when
   * asked after the month ended]; null =
   * Zerion couldn't answer for that month) and the 30/90-day windows,
   * instead of `days`. No per-coin list, win rate or best day. */
  source?: "zerion";
  months?: Record<string, [number, number, number?] | null>;
  windows?: { d30: number | null; d90: number | null };
  /** From Zerion's all-time answer: fees paid on trades, the return on the
   * coins sold (%) and what they cost. Missing on records loaded before
   * 2026-09-30's refresh. */
  feesUsd?: number | null;
  closedReturnPct?: number | null;
  closedCostUsd?: number | null;
}

/** A coin's result: [month it was last sold (YYYY-MM), realized USD, return %,
 * ticker, USD put in]. The fifth is missing on coins saved before 2026-09-28. */
export type CoinEntry = [string, number, number | null, string, number?];

/** One coin as the positions endpoint returns it (the adapter's shape). */
export interface FetchedCoin {
  mint: string;
  symbol: string;
  realizedUsd: number;
  roiPct: number | null;
  investedUsd: number | null;
  lastSellMs: number | null;
  lastTradeMs: number;
}

export interface CoinBrief {
  mint: string;
  symbol: string;
  pnlUsd: number;
  roiPct: number | null;
  /** What was put into the position; null when unknown. */
  investedUsd: number | null;
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
    const entry: CoinEntry = [monthOf(c.lastSellMs), Math.round(c.realizedUsd * 100) / 100, c.roiPct === null ? null : Math.round(c.roiPct * 10) / 10, c.symbol];
    if (c.investedUsd !== null) entry.push(Math.round(c.investedUsd * 100) / 100);
    index[c.mint] = entry;
  }
  const oldest = monthOf(nowMs - 365 * 24 * 60 * 60 * 1000);
  for (const [mint, e] of Object.entries(index)) if (e[0] < oldest) delete index[mint];
  return { cursor, index };
}

/** What was put in, from the result and its return (return = profit ÷ put
 * in) — for coins saved before the amount was. Unreliable near 0%, so none. */
export function investedFrom(pnlUsd: number, roiPct: number | null): number | null {
  if (roiPct === null || Math.abs(roiPct) < 1) return null;
  return Math.abs((pnlUsd * 100) / roiPct);
}

/** A month's coins across records: how many, how many won, and the biggest
 * gains and losses (with the mint, for the copy button). */
export function coinsByMonth(records: readonly StoredTradingRecord[]): Record<string, MonthCoins> {
  const by = new Map<string, CoinBrief[]>();
  for (const r of records) {
    for (const [mint, [month, pnlUsd, roiPct, symbol, invested]] of Object.entries(r.coins?.index ?? {})) {
      by.set(month, [...(by.get(month) ?? []), { mint, symbol, pnlUsd, roiPct, investedUsd: invested ?? investedFrom(pnlUsd, roiPct) }]);
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
  /** Null when a Zerion window couldn't be read (unknown, never 0). */
  last90Usd: number | null;
  last30Usd: number | null;
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
  /** Whether any address can list coins (Solana; Zerion gives totals only). */
  hasCoinDetail: boolean;
  /** Zerion records: the return on coins sold (realized ÷ their cost) and
   * that cost, all addresses together; null when any lacks it. */
  closedReturn: { pct: number; costUsd: number } | null;
  /** Zerion records: fees paid on trades, all time. */
  feesUsd: number | null;
  /** The largest fall of the running realized profit between month-ends
   * over the months shown (usd ≥ 0; 0 = it never fell; `from` "" = the
   * start); null with no months. */
  monthDrop: { usd: number; from: string; to: string } | null;
}

/** Realized ÷ cost over the coins sold, every Zerion address together. */
function closedReturnOf(zerion: readonly StoredTradingRecord[]): TradingSummary["closedReturn"] {
  if (zerion.length === 0 || zerion.some((r) => typeof r.closedCostUsd !== "number" || typeof r.closedReturnPct !== "number")) return null;
  const cost = zerion.reduce((s, r) => s + r.closedCostUsd!, 0);
  if (cost <= 0) return null;
  // Each address's realized on its sold coins is its % × its cost.
  const realized = zerion.reduce((s, r) => s + (r.closedReturnPct! / 100) * r.closedCostUsd!, 0);
  return { pct: (realized / cost) * 100, costUsd: cost };
}

/** Peak-to-trough fall of the running realized profit, month by month. */
export function monthDrop(months: readonly { month: string; realizedUsd: number }[]): TradingSummary["monthDrop"] {
  if (months.length === 0) return null;
  let run = 0;
  let peak = 0;
  let peakMonth = ""; // "" = before the first month shown
  let best = { usd: 0, from: "", to: months[0].month };
  for (const m of months) {
    run += m.realizedUsd;
    if (run > peak) {
      peak = run;
      peakMonth = m.month;
    } else if (peak - run > best.usd) best = { usd: peak - run, from: peakMonth, to: m.month };
  }
  return best;
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
  // Zerion records (EVM): their months as they come, for the past 12 months.
  const yearAgoMonth = addDays(today, -365).slice(0, 7);
  let zerionYear = 0;
  for (const r of records) {
    for (const [month, v] of Object.entries(r.months ?? {})) {
      if (!v || month <= yearAgoMonth) continue;
      const [realizedUsd, investedUsd] = v;
      if (realizedUsd === 0 && investedUsd === 0) continue; // no activity that month
      const m = byMonth.get(month) ?? { realizedUsd: 0, trades: 0 };
      m.realizedUsd += realizedUsd;
      byMonth.set(month, m);
      zerionYear += realizedUsd;
    }
  }
  const months = [...byMonth].map(([month, m]) => ({ month, ...m })).sort((a, b) => a.month.localeCompare(b.month));
  const zerion = records.filter((r) => r.source === "zerion");
  const since = (days: number, window: "d30" | "d90") => {
    if (zerion.some((r) => r.windows?.[window] == null)) return null;
    const fromDays = [...byDay].filter(([date]) => date > addDays(today, -days)).reduce((s, [, d]) => s + d.usd, 0);
    return fromDays + zerion.reduce((s, r) => s + r.windows![window]!, 0);
  };
  const yearUsd = [...byDay.values()].reduce((s, d) => s + d.usd, 0) + zerionYear;
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
    last90Usd: since(90, "d90"),
    last30Usd: since(30, "d30"),
    profitableMonths: months.filter((m) => m.realizedUsd > 0).length,
    activeMonths: months.length,
    bestMonthShare: yearUsd > 0 && months.length > 0 ? bestMonth / yearUsd : null,
    bestDay: best ? { date: best[0], realizedUsd: best[1].usd } : null,
    bestDayShare: yearUsd > 0 && best ? best[1].usd / yearUsd : null,
    drawdownUsd: one?.drawdownUsd ?? null,
    drawdownPct: one?.drawdownPct ?? null,
    monthCoins: coinsByMonth(records),
    hasCoinDetail: records.some((r) => r.source !== "zerion"),
    closedReturn: closedReturnOf(zerion),
    feesUsd: zerion.length > 0 && zerion.every((r) => typeof r.feesUsd === "number") ? zerion.reduce((s, r) => s + r.feesUsd!, 0) : null,
    monthDrop: monthDrop(months),
  };
}

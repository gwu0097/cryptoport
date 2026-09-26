// Risk profile of the portfolio as it is now: today's holdings, held through
// the last RISK_WINDOW_DAYS days that have real daily prices (a stretch with
// no stored prices is skipped, not filled). Pure — the caller passes
// each asset's date -> usd series (priceHistory.ts getPriceHistoryMap).
//
// Only real prices are used. A return is taken only between two consecutive
// calendar days that both have a price; a day some modeled asset lacks is
// left out of the window rather than filled in. An asset with too few days is
// not modeled, and the result says how much of the portfolio that leaves out
// (unknown is never 0, CLAUDE.md §4.1).

export const RISK_WINDOW_DAYS = 90;
/** An asset is modeled when it has a return on at least this share of the
 * window's days. */
export const MIN_ASSET_COVERAGE = 0.8;
/** Fewer common days than this and the statistics mean too little to show. */
export const MIN_COMMON_DAYS = 30;
/** Crypto trades every day, so daily volatility annualizes by √365. */
const DAYS_PER_YEAR = 365;
/** A price that stayed within this of $1 on every window day is cash-like. */
const STABLE_BAND = 0.02;

export type DailyPrices = ReadonlyMap<string, number>;

export interface RiskAssetInput {
  key: string;
  ticker: string;
  valueUsd: number;
  prices: DailyPrices | undefined;
}

export interface AssetRisk {
  key: string;
  ticker: string;
  valueUsd: number;
  /** Share of the modeled value. */
  weight: number;
  /** Annualized volatility, as a fraction (0.8 = 80%). */
  volatility: number;
  /** Sensitivity to BTC's daily move; null without a BTC series. */
  beta: number | null;
  /** Share of the portfolio's variance this asset accounts for (the
   * shares sum to 1; a hedge can be negative). */
  riskShare: number;
  /** Stayed within ±2% of $1 on every window day. */
  cashLike: boolean;
}

export interface RiskProfile {
  /** The days the statistics are computed over (each has a return for
   * every modeled asset). */
  days: number;
  from: string;
  to: string;
  modeledUsd: number;
  /** Value not modeled: too little price history, or no price series at
   * all (protocol positions, unpriced tokens). */
  unmodeled: { usd: number; tickers: string[] };
  volatility: number;
  /** Worst peak-to-trough fall of the portfolio over the window, as a
   * negative fraction. */
  maxDrawdown: number;
  worstDay: { date: string; change: number };
  bestDay: { date: string; change: number };
  beta: number | null;
  correlation: number | null;
  /** What a 20% BTC fall would do to the modeled value, through each
   * asset's beta (null without a BTC series). */
  btcDrop20Usd: number | null;
  cashLikeUsd: number;
  /** BTC over the same days, for comparison (null without its series). */
  benchmark: { volatility: number; maxDrawdown: number } | null;
  assets: AssetRisk[];
}

export function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** date -> return vs the day before, for each day whose previous calendar
 * day also has a price. */
export function dailyReturns(prices: DailyPrices): Map<string, number> {
  const out = new Map<string, number>();
  for (const [date, p] of prices) {
    const prev = prices.get(previousDay(date));
    if (prev !== undefined && prev > 0 && p > 0) out.set(date, p / prev - 1);
  }
  return out;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function covariance(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}

/** Worst peak-to-trough fall of a compounded return series (≤ 0). */
export function maxDrawdown(returns: readonly number[]): number {
  let level = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    level *= 1 + r;
    peak = Math.max(peak, level);
    worst = Math.min(worst, level / peak - 1);
  }
  return worst;
}

/**
 * The portfolio's risk over the last RISK_WINDOW_DAYS days any held asset has
 * a return for, or null when fewer than MIN_COMMON_DAYS of them have a return
 * for every asset that could be modeled. `btc` is the benchmark series.
 */
export function riskProfile(assets: readonly RiskAssetInput[], btc: DailyPrices | undefined): RiskProfile | null {
  const held = assets.filter((a) => a.valueUsd > 0).map((a) => ({ ...a, returns: a.prices ? dailyReturns(a.prices) : new Map<string, number>() }));
  const windowDays = [...new Set(held.flatMap((a) => [...a.returns.keys()]))].sort().slice(-RISK_WINDOW_DAYS);

  const returnsOf = new Map<string, Map<string, number>>();
  const modeled: RiskAssetInput[] = [];
  const unmodeled = { usd: 0, tickers: [] as string[] };
  for (const a of held) {
    const r = a.returns;
    const covered = windowDays.filter((d) => r.has(d)).length;
    if (windowDays.length > 0 && covered >= MIN_ASSET_COVERAGE * windowDays.length) {
      modeled.push(a);
      returnsOf.set(a.key, r);
    } else {
      unmodeled.usd += a.valueUsd;
      unmodeled.tickers.push(a.ticker);
    }
  }
  // Largest first, so a caption naming a few names the ones that matter.
  const valueOf = new Map(held.map((a) => [a.ticker, a.valueUsd]));
  unmodeled.tickers.sort((x, y) => (valueOf.get(y) ?? 0) - (valueOf.get(x) ?? 0));
  const days = windowDays.filter((d) => modeled.every((a) => returnsOf.get(a.key)!.has(d)));
  if (modeled.length === 0 || days.length < MIN_COMMON_DAYS) return null;

  const modeledUsd = modeled.reduce((s, a) => s + a.valueUsd, 0);
  const weights = modeled.map((a) => a.valueUsd / modeledUsd);
  const series = modeled.map((a) => days.map((d) => returnsOf.get(a.key)!.get(d)!));
  const portfolio = days.map((_, t) => series.reduce((s, x, i) => s + weights[i] * x[t], 0));

  const btcReturns = btc ? dailyReturns(btc) : null;
  const benchmark = btcReturns && days.every((d) => btcReturns.has(d)) ? days.map((d) => btcReturns.get(d)!) : null;
  const benchVar = benchmark ? covariance(benchmark, benchmark) : 0;
  const betaOf = (xs: number[]) => (benchmark && benchVar > 0 ? covariance(xs, benchmark) / benchVar : null);

  // Variance share: w_i · cov(r_i, r_p) / var(r_p) — the shares sum to 1.
  const portVar = covariance(portfolio, portfolio);
  const assetRisk: AssetRisk[] = modeled.map((a, i) => {
    const prices = days.map((d) => a.prices!.get(d)!);
    return {
      key: a.key,
      ticker: a.ticker,
      valueUsd: a.valueUsd,
      weight: weights[i],
      volatility: Math.sqrt(covariance(series[i], series[i]) * DAYS_PER_YEAR),
      beta: betaOf(series[i]),
      riskShare: portVar > 0 ? (weights[i] * covariance(series[i], portfolio)) / portVar : 0,
      cashLike: prices.every((p) => Math.abs(p - 1) <= STABLE_BAND),
    };
  });

  const beta = betaOf(portfolio);
  const byDay = days.map((date, t) => ({ date, change: portfolio[t] }));
  const worstDay = byDay.reduce((w, d) => (d.change < w.change ? d : w));
  const bestDay = byDay.reduce((b, d) => (d.change > b.change ? d : b));
  return {
    days: days.length,
    from: days[0],
    to: days.at(-1)!,
    modeledUsd,
    unmodeled,
    volatility: Math.sqrt(portVar * DAYS_PER_YEAR),
    maxDrawdown: maxDrawdown(portfolio),
    worstDay,
    bestDay,
    beta,
    correlation: benchmark && benchVar > 0 && portVar > 0 ? covariance(portfolio, benchmark) / Math.sqrt(portVar * benchVar) : null,
    btcDrop20Usd: benchmark ? assetRisk.reduce((s, a) => s + a.valueUsd * (a.beta ?? 0) * -0.2, 0) : null,
    cashLikeUsd: assetRisk.filter((a) => a.cashLike).reduce((s, a) => s + a.valueUsd, 0),
    benchmark: benchmark ? { volatility: Math.sqrt(benchVar * DAYS_PER_YEAR), maxDrawdown: maxDrawdown(benchmark) } : null,
    assets: assetRisk.sort((a, b) => b.riskShare - a.riskShare),
  };
}

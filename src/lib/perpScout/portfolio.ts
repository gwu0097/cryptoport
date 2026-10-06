// A Hyperliquid account's own PnL history (info `portfolio`) reduced to the
// numbers the screen judges, pure. Drawdown is measured on the PnL curve, not
// account value: deposits and withdrawals move account value and would read
// as gains or 100% drawdowns.

const WEEK_MS = 7 * 24 * 60 * 60_000;

export type Series = [number, number][];

export interface PortfolioSeries {
  accountValue: Series;
  /** Cumulative PnL since the window's start. */
  pnl: Series;
}

export interface TraderStats {
  /** Whole weeks between the curve's first point and now. */
  historyWeeks: number;
  /** Net PnL over the curve (last − first). */
  totalPnl: number;
  /** Median of the positive account values: what the trader usually runs. */
  typicalEquity: number | null;
  maxDrawdownUsd: number;
  /** maxDrawdownUsd ÷ typicalEquity. */
  drawdownShare: number | null;
  /** Weeks with a gain ÷ weeks with any change. */
  winningWeeksShare: number | null;
  /** Sum of the 4 best weeks ÷ totalPnl; null when totalPnl ≤ 0. */
  bestFourShare: number | null;
  /** totalPnl ÷ typicalEquity per year of history. */
  yearlyReturn: number | null;
}

const toSeries = (x: unknown): Series | null => {
  if (!Array.isArray(x)) return null;
  const out: Series = [];
  for (const p of x) {
    if (!Array.isArray(p)) continue;
    const t = Number(p[0]);
    const v = Number(p[1]);
    if (Number.isFinite(t) && Number.isFinite(v)) out.push([t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
};

/** The all-time perps window (`perpAllTime`), else all-time (spot included).
 * An answer without either is an error. */
export function parsePortfolio(json: unknown): PortfolioSeries {
  if (!Array.isArray(json)) throw new Error("Hyperliquid portfolio: not a list");
  const windows = new Map((json as unknown[]).filter((w): w is [string, unknown] => Array.isArray(w) && typeof w[0] === "string").map(([k, v]) => [k, v]));
  for (const name of ["perpAllTime", "allTime"]) {
    const w = windows.get(name) as { accountValueHistory?: unknown; pnlHistory?: unknown } | undefined;
    const accountValue = toSeries(w?.accountValueHistory);
    const pnl = toSeries(w?.pnlHistory);
    if (accountValue && pnl && pnl.length > 0) return { accountValue, pnl };
  }
  throw new Error("Hyperliquid portfolio: no all-time PnL history");
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The curve's value at time t: its last point at or before t (its first
 * point before it starts). */
function valueAt(series: Series, t: number): number {
  let v = series[0][1];
  for (const [ts, x] of series) {
    if (ts > t) break;
    v = x;
  }
  return v;
}

/** Each week's PnL change, newest first, in weeks ending at `nowMs`. */
export function weeklyChanges(pnl: Series, nowMs: number): number[] {
  if (pnl.length === 0) return [];
  const weeks = Math.floor((nowMs - pnl[0][0]) / WEEK_MS);
  const out: number[] = [];
  for (let k = 0; k < weeks; k++) out.push(valueAt(pnl, nowMs - k * WEEK_MS) - valueAt(pnl, nowMs - (k + 1) * WEEK_MS));
  return out;
}

/** Largest fall from a running peak of the PnL curve. */
export function maxDrawdown(pnl: Series): number {
  let peak = -Infinity;
  let worst = 0;
  for (const [, v] of pnl) {
    peak = Math.max(peak, v);
    worst = Math.max(worst, peak - v);
  }
  return worst;
}

export function traderStats(series: PortfolioSeries, nowMs: number): TraderStats {
  const { pnl } = series;
  const historyWeeks = pnl.length ? Math.floor((nowMs - pnl[0][0]) / WEEK_MS) : 0;
  const totalPnl = pnl.length ? pnl[pnl.length - 1][1] - pnl[0][1] : 0;
  const typicalEquity = median(series.accountValue.map(([, v]) => v).filter((v) => v > 0));
  const maxDrawdownUsd = maxDrawdown(pnl);
  const weeks = weeklyChanges(pnl, nowMs).filter((w) => w !== 0);
  const best4 = [...weeks].sort((a, b) => b - a).slice(0, 4).filter((w) => w > 0).reduce((s, w) => s + w, 0);
  const years = historyWeeks / 52.18;
  return {
    historyWeeks,
    totalPnl,
    typicalEquity,
    maxDrawdownUsd,
    drawdownShare: typicalEquity ? maxDrawdownUsd / typicalEquity : null,
    winningWeeksShare: weeks.length ? weeks.filter((w) => w > 0).length / weeks.length : null,
    bestFourShare: totalPnl > 0 ? best4 / totalPnl : null,
    yearlyReturn: typicalEquity && years > 0 ? totalPnl / typicalEquity / years : null,
  };
}

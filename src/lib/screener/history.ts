// Pure history-derived metrics (Phase 2b) — see history.test.ts. Inputs are
// an asset's stored snapshot readings (backfilled daily points + live 07:00
// readings); nothing here fetches anything.
//
// SPEC standing rule (flows vs levels): flows use complete UTC days only;
// levels compare like with like. Prices are levels, so every asset price is
// paired with a BTC price of the SAME KIND (pairBtc): a backfilled daily point
// with BTC's daily point for that date, a live reading with BTC read at that
// same moment. Revenue windows are built from stored rolling 30-day totals,
// which are already complete-day flows (backfill ends yesterday; DefiLlama's
// live total30d is its own rolling figure).

export const DAY_MS = 86_400_000;

export interface Reading {
  observed_at: string; // ISO timestamp
  is_backfilled: boolean;
  run_id: string;
  price_usd: number | null;
  market_cap_usd: number | null;
  circulating_supply: number | null;
  revenue_30d: number | null;
  /** Backfilled only: this row's price came from CoinGecko's market_chart
   * (a 00:00 UTC daily point) instead of DefiLlama's /chart. */
  price_from_coingecko?: boolean;
  /** Live only: from a DEGRADED run (CoinGecko unavailable — market cap/
   * supply null, price from DefiLlama). */
  degraded?: boolean;
  /** The price at the SAME moment as market_cap_usd, for implied supply
   * (market cap ÷ price). A backfilled DefiLlama-priced row pairs a 00:00
   * CoinGecko market cap with a ~21:31 DefiLlama price (verified 2026-09-23:
   * mcap ÷ 00:00 price is flat day to day, mcap ÷ stored price has 0.65%
   * daily noise). undefined = use price_usd (production today, where no
   * same-moment price is stored); null = no same-moment price known, so
   * implied supply is null rather than mixed-moment. */
  price_at_mcap_moment?: number | null;
}

/** date (YYYY-MM-DD) -> that day's reading, only readings observed at or
 * before `asOf` (point-in-time: a run never sees later data). Same rule as
 * runSelection.ts: a complete reading beats a degraded one; then the latest
 * wins. */
export function dailyReadings(readings: readonly Reading[], asOf: string): Map<string, Reading> {
  const byDay = new Map<string, Reading>();
  for (const r of readings) {
    if (r.observed_at > asOf) continue;
    const day = r.observed_at.slice(0, 10);
    const cur = byDay.get(day);
    const wins = !cur || (!!r.degraded !== !!cur.degraded ? !r.degraded : r.observed_at > cur.observed_at);
    if (wins) byDay.set(day, r);
  }
  return byDay;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The reading on `date`, else the nearest within ±tolDays (earlier wins a
 * tie); null when nothing is close enough, or the value is null. */
export function readingNear<T>(
  byDay: ReadonlyMap<string, Reading>,
  date: string,
  tolDays: number,
  pick: (r: Reading) => T | null,
): { reading: Reading; value: T } | null {
  for (let off = 0; off <= tolDays; off++) {
    for (const d of off === 0 ? [date] : [shiftDate(date, -off), shiftDate(date, off)]) {
      const r = byDay.get(d);
      const v = r ? pick(r) : null;
      if (r && v !== null) return { reading: r, value: v };
    }
  }
  return null;
}

/**
 * BTC prices at the same MOMENTS as the asset readings they're paired with
 * (SPEC standing rule, levels). "Daily point" is not a moment: DefiLlama's
 * /chart spaces its points from the requested start time, so a backfilled
 * asset price for date D is DefiLlama's price at the BACKFILL RUN's time of
 * day on D (live-verified: HYPE's stored 09-01 price 82.046 = DefiLlama at
 * 21:31, the run's start; 00:00 was 84.16). Pairing it with a 00:00 BTC point
 * offset every return by ~21.5h and pulled the universe's median beta to
 * ~0.07 on the first 2b run — caught before shipping.
 */
export interface BtcReference {
  /** Backfilled DefiLlama-priced rows: BTC on the same /chart time-of-day
   * grid as the backfill run that wrote them — run_id -> date -> price. */
  backfillGridByRun: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Backfilled rows priced from CoinGecko's market_chart (00:00 UTC daily
   * points): BTC at 00:00 UTC — date -> price. */
  midnight: ReadonlyMap<string, number>;
  /** Live rows: BTC read at the same moment, by run_id (same CoinGecko
   * /coins/markets response, or DefiLlama at observed_at for older runs). */
  byRun: ReadonlyMap<string, number>;
}

/** The BTC price read at the same moment as this asset reading. Never falls
 * back to a different moment — no same-moment price means null. */
export function pairBtc(r: Reading, btc: BtcReference): number | null {
  if (!r.is_backfilled) return btc.byRun.get(r.run_id) ?? null;
  const date = r.observed_at.slice(0, 10);
  if (r.price_from_coingecko) return btc.midnight.get(date) ?? null;
  return btc.backfillGridByRun.get(r.run_id)?.get(date) ?? null;
}

/** Relative-to-BTC return over `days`, ratio form: (P_t/P_0) / (B_t/B_0) - 1
 * — equivalently the change in the asset's price measured in BTC. */
export function momentumVsBtc(
  byDay: ReadonlyMap<string, Reading>,
  endDate: string,
  days: number,
  tolDays: number,
  btc: BtcReference,
): number | null {
  const inBtc = (r: Reading): number | null => {
    const b = pairBtc(r, btc);
    return r.price_usd !== null && r.price_usd > 0 && b !== null && b > 0 ? r.price_usd / b : null;
  };
  const end = readingNear(byDay, endDate, 0, inBtc);
  const start = readingNear(byDay, shiftDate(endDate, -days), tolDays, inBtc);
  if (!end || !start) return null;
  return end.value / start.value - 1;
}

/** OLS slope of the asset's daily log returns on BTC's over the `days` ending
 * at `endDate`; each return uses consecutive calendar days with both prices
 * (BTC paired by kind). Null below `minPairs` paired returns. */
export function betaVsBtc(
  byDay: ReadonlyMap<string, Reading>,
  endDate: string,
  days: number,
  minPairs: number,
  btc: BtcReference,
): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d1 = shiftDate(endDate, -i);
    const d0 = shiftDate(d1, -1);
    const r1 = byDay.get(d1);
    const r0 = byDay.get(d0);
    if (!r0 || !r1) continue;
    const [p0, p1, b0, b1] = [r0.price_usd, r1.price_usd, pairBtc(r0, btc), pairBtc(r1, btc)];
    if (!(p0! > 0 && p1! > 0 && b0! > 0 && b1! > 0)) continue;
    ys.push(Math.log(p1! / p0!));
    xs.push(Math.log(b1! / b0!));
  }
  if (xs.length < minPairs) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varX += (xs[i] - mx) ** 2;
  }
  return varX > 0 ? cov / varX : null;
}

/** 90-day revenue ending at `endDate` = sum of the stored rolling 30-day
 * totals at endDate, -30, -60 (each within tolerance); null if any is missing. */
export function revenue90d(byDay: ReadonlyMap<string, Reading>, endDate: string, tolDays: number): number | null {
  let sum = 0;
  for (const back of [0, 30, 60]) {
    const hit = readingNear(byDay, shiftDate(endDate, -back), tolDays, (r) => r.revenue_30d);
    if (!hit) return null;
    sum += hit.value;
  }
  return sum;
}

/** Actual days between two readings — the ±tolerance match means a "90-day"
 * window can really be 87-93 days, and annualizing must use the real gap. */
export function gapDays(r0: Reading, r1: Reading): number {
  return (new Date(r1.observed_at).getTime() - new Date(r0.observed_at).getTime()) / DAY_MS;
}

/** Annualized growth of a supply level between two dates: (s1/s0)^(365/days) - 1. */
export function annualizedGrowth(s0: number | null, s1: number | null, days: number): number | null {
  if (s0 === null || s1 === null || !(s0 > 0) || !(s1 > 0) || !(days > 0)) return null;
  return (s1 / s0) ** (365 / days) - 1;
}

export interface HistoryMetrics {
  mom_3w: number | null;
  mom_12w: number | null;
  beta_btc: number | null;
  rev_growth: number | null;
  rev_90d_change: number | null;
  dilution_rate: number | null;
  dilution_rate_implied: number | null;
}

export interface HistoryConfig {
  lookbackToleranceDays: number; // ±2
  betaDays: number; // 90
  betaMinPairs: number; // 60
  dilutionDays: number; // 90
  dilutionToleranceDays: number; // ±3
}

/** Every 2b metric for one asset as of `asOf` (the run's observed_at). */
export function computeHistoryMetrics(
  readings: readonly Reading[],
  asOf: string,
  btc: BtcReference,
  cfg: HistoryConfig,
): HistoryMetrics {
  const byDay = dailyReadings(readings, asOf);
  const endDate = asOf.slice(0, 10);
  const tol = cfg.lookbackToleranceDays;

  const rev90 = revenue90d(byDay, endDate, tol);
  const rev90Prior = revenue90d(byDay, shiftDate(endDate, -90), tol);
  const rev30 = readingNear(byDay, endDate, 0, (r) => r.revenue_30d)?.value ?? null;

  // Measured: live circulating supply at both ends (backfilled rows carry
  // none, so this stays null until ~90 days of live history exist).
  const liveOnly = new Map([...byDay].filter(([, r]) => !r.is_backfilled));
  const measured0 = readingNear(liveOnly, shiftDate(endDate, -cfg.dilutionDays), cfg.dilutionToleranceDays, (r) => r.circulating_supply);
  const measured1 = readingNear(liveOnly, endDate, 0, (r) => r.circulating_supply);
  // Implied: market cap / price at both ends (display only — never a tier input).
  const implied = (r: Reading) => {
    const p = r.price_at_mcap_moment === undefined ? r.price_usd : r.price_at_mcap_moment;
    return r.market_cap_usd !== null && p !== null && p > 0 ? r.market_cap_usd / p : null;
  };
  const implied0 = readingNear(byDay, shiftDate(endDate, -cfg.dilutionDays), cfg.dilutionToleranceDays, implied);
  const implied1 = readingNear(byDay, endDate, 0, implied);

  return {
    mom_3w: momentumVsBtc(byDay, endDate, 21, tol, btc),
    mom_12w: momentumVsBtc(byDay, endDate, 84, tol, btc),
    beta_btc: betaVsBtc(byDay, endDate, cfg.betaDays, cfg.betaMinPairs, btc),
    rev_growth: rev30 !== null && rev90 !== null && rev90 > 0 ? (3 * rev30) / rev90 - 1 : null,
    rev_90d_change: rev90 !== null && rev90Prior !== null && rev90Prior > 0 ? rev90 / rev90Prior - 1 : null,
    dilution_rate: measured0 && measured1 ? annualizedGrowth(measured0.value, measured1.value, gapDays(measured0.reading, measured1.reading)) : null,
    dilution_rate_implied: implied0 && implied1 ? annualizedGrowth(implied0.value, implied1.value, gapDays(implied0.reading, implied1.reading)) : null,
  };
}

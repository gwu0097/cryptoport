// Pure Phase 4 panel construction — see backtest.test.ts and PHASE_4_PLAN.md
// ("Definitions"). One period = one formation date D: every asset's state at
// D, scored through the PRODUCTION path (computeAssetMetrics +
// computeHistoryMetrics + scoreRun — SPEC: the backtest never gets its own
// scoring implementation), plus forward returns at D+30 / D+90. No tests of
// predictive power live here (that's 4b); this only builds the panel.

import { SCREENER_CONFIG, type ScreenerConfig } from "./config.ts";
import { computeAssetMetrics, type SnapshotForMetrics, type GateStatus, type AssetMetrics } from "./metrics.ts";
import { computeHistoryMetrics, dailyReadings, pairBtc, shiftDate, type Reading, type BtcReference } from "./history.ts";
import { scoreRun, type ScoreInput } from "./scores.ts";

export const HORIZONS = [30, 90] as const;

/** Formation dates per PHASE_4_PLAN: D_last = lastDataDate − horizon, then
 * back in steps of `step` days while `eligible(D)` holds (the first
 * ineligible date stops the walk and is not included). Oldest first. */
export function formationDates(lastDataDate: string, horizon: number, step: number, eligible: (d: string) => boolean): string[] {
  const out: string[] = [];
  for (let d = shiftDate(lastDataDate, -horizon); eligible(d); d = shiftDate(d, -step)) out.push(d);
  return out.reverse();
}

/** A stored reading plus the fields the panel needs that history's Reading
 * doesn't carry. */
export interface PanelReading extends Reading {
  volume_24h_usd: number | null;
  fees_30d: number | null;
  holders_revenue_30d: number | null;
}

export interface PanelAsset {
  asset_id: string;
  gecko_id: string;
  sector: string | null;
  readings: readonly PanelReading[];
}

/** Who is in a period's tested population. "rated" = the production kill
 * filters (1-year window). "deep" = the 2/3-year windows' labeled universe
 * (PHASE_4_PLAN): a price at D, trailing 30-day revenue at or above the
 * annualized floor, and in scope — no market cap or volume gates exist that
 * far back. Scoring is the production path either way. */
export type PopulationRule = "rated" | "deep";

export function inPopulation(m: AssetMetrics, priceAtD: number | null, rule: PopulationRule, config: ScreenerConfig = SCREENER_CONFIG): boolean {
  if (rule === "rated") return m.rated;
  return (
    priceAtD !== null &&
    m.gate_status.out_of_scope === "pass" &&
    m.rev_ann !== null &&
    m.rev_ann >= config.gates.minRevenueAnnualizedUsd
  );
}

export interface PanelRow {
  date: string;
  asset_id: string;
  gecko_id: string;
  /** In the period's tested population (see PopulationRule). */
  rated: boolean;
  gates_failed: string;
  sector_bucket: string;
  size_log_mcap: number | null;
  mom_3w: number | null;
  mom_12w: number | null;
  beta_btc: number | null;
  ps_circ: number | null;
  pf_circ: number | null;
  dilution_rate_implied: number | null;
  timing_score: number | null;
  timing_percentile: number | null;
  setup_tag: string | null;
  quality_risk_tier: string | null;
  /** Raw prices so a verifier can recompute returns from the definitions. */
  price_d: number | null;
  btc_d: number | null;
  price_d30: number | null;
  btc_d30: number | null;
  price_d90: number | null;
  btc_d90: number | null;
  fwd30_btc: number | null;
  fwd90_btc: number | null;
  /** Filled per period after all rows exist (needs the rated set's mean). */
  fwd30_ew: number | null;
  fwd90_ew: number | null;
  /** Backfilled reading priced by the CoinGecko fallback at D. */
  price_from_coingecko: boolean;
}

/** The asset's price and its same-moment BTC on exactly `date` — no
 * nearby-day substitution (definitions: a missing reading excludes the
 * asset from that period). */
function priceAndBtc(byDay: ReadonlyMap<string, Reading>, date: string, btc: BtcReference): { p: number | null; b: number | null } {
  const r = byDay.get(date);
  if (!r || r.price_usd === null || !(r.price_usd > 0)) return { p: null, b: null };
  const b = pairBtc(r, btc);
  return { p: r.price_usd, b: b !== null && b > 0 ? b : null };
}

const fwd = (p0: number | null, p1: number | null, b0: number | null, b1: number | null): number | null =>
  p0 === null || p1 === null || b0 === null || b1 === null ? null : p1 / p0 / (b1 / b0) - 1;

/** One formation date's panel. The asset's state at D is its reading ON D
 * (asOf = the end of D); an asset with no reading on D isn't in that day's
 * universe. Unlock data and source conflicts don't exist historically:
 * unlocks null (the rule is not evaluable, as live), conflicts false. */
export function buildPeriod(
  date: string,
  assets: readonly PanelAsset[],
  btc: BtcReference,
  config: ScreenerConfig = SCREENER_CONFIG,
  rule: PopulationRule = "rated",
): PanelRow[] {
  const asOf = `${date}T23:59:59.999Z`;
  const rows: PanelRow[] = [];
  const scoreInputs: ScoreInput[] = [];

  for (const a of assets) {
    const atD = dailyReadings(a.readings, asOf).get(date) as PanelReading | undefined;
    if (!atD) continue;
    const snapshot: SnapshotForMetrics = {
      asset_id: a.asset_id,
      gecko_id: a.gecko_id,
      sector: a.sector,
      price_usd: atD.price_usd,
      market_cap_usd: atD.market_cap_usd,
      fdv_usd: null, // backfilled rows carry no FDV/supply/TVL
      circulating_supply: null,
      total_supply: null,
      max_supply: null,
      tvl_usd: null,
      fees_30d: atD.fees_30d,
      revenue_30d: atD.revenue_30d,
      holders_revenue_30d: atD.holders_revenue_30d,
      volume_24h_usd: atD.volume_24h_usd,
    };
    const m = computeAssetMetrics(snapshot, config, computeHistoryMetrics(a.readings, asOf, btc, config.history));
    const allDays = dailyReadings(a.readings, "9999-12-31T00:00:00Z");
    const d0 = priceAndBtc(allDays, date, btc);
    const d30 = priceAndBtc(allDays, shiftDate(date, 30), btc);
    const d90 = priceAndBtc(allDays, shiftDate(date, 90), btc);
    const inPop = inPopulation(m, d0.p, rule, config);
    rows.push({
      date,
      asset_id: a.asset_id,
      gecko_id: a.gecko_id,
      rated: inPop,
      gates_failed: (Object.keys(m.gate_status) as (keyof GateStatus)[]).filter((g) => m.gate_status[g] === "fail").join(","),
      sector_bucket: m.sector_bucket,
      size_log_mcap: m.size_log_mcap,
      mom_3w: m.mom_3w,
      mom_12w: m.mom_12w,
      beta_btc: m.beta_btc,
      ps_circ: m.ps_circ,
      pf_circ: m.pf_circ,
      dilution_rate_implied: m.dilution_rate_implied,
      timing_score: null,
      timing_percentile: null,
      setup_tag: null,
      quality_risk_tier: null,
      price_d: d0.p,
      btc_d: d0.b,
      price_d30: d30.p,
      btc_d30: d30.b,
      price_d90: d90.p,
      btc_d90: d90.b,
      fwd30_btc: fwd(d0.p, d30.p, d0.b, d30.b),
      fwd90_btc: fwd(d0.p, d90.p, d0.b, d90.b),
      fwd30_ew: null,
      fwd90_ew: null,
      price_from_coingecko: !!atD.price_from_coingecko,
    });
    if (inPop) {
      scoreInputs.push({
        asset_id: a.asset_id,
        mom_3w: m.mom_3w,
        mom_12w: m.mom_12w,
        beta_btc: m.beta_btc,
        rev_90d_change: m.rev_90d_change,
        dilution_rate: m.dilution_rate,
        unlocks_90d_pct_circulating: null,
        market_cap_usd: atD.market_cap_usd,
        has_source_conflict: false,
      });
    }
  }

  // Score B, tier and tag for the rated set, exactly as the daily run does.
  // No regime history exists for past dates; the modifiers are all 0 anyway.
  const { scores } = scoreRun(scoreInputs, null, config);
  const byAsset = new Map(scores.map((s) => [s.asset_id, s]));
  for (const r of rows) {
    const s = byAsset.get(r.asset_id);
    if (!s) continue;
    r.timing_score = s.timing_score;
    r.timing_percentile = s.timing_percentile;
    r.setup_tag = s.setup_tag;
    r.quality_risk_tier = s.quality_risk_tier;
  }

  // Equal-weight basket (definitions): r_i − mean(r_j) over the period's RATED
  // assets with both prices.
  for (const h of HORIZONS) {
    const priceKey = h === 30 ? "price_d30" : "price_d90";
    const raw = (r: PanelRow) => (r.price_d !== null && r[priceKey] !== null ? r[priceKey]! / r.price_d - 1 : null);
    const ratedRaw = rows.filter((r) => r.rated).map(raw).filter((v): v is number => v !== null);
    const mean = ratedRaw.length ? ratedRaw.reduce((a, b) => a + b, 0) / ratedRaw.length : null;
    for (const r of rows) {
      const v = raw(r);
      const ew = v === null || mean === null ? null : v - mean;
      if (h === 30) r.fwd30_ew = ew;
      else r.fwd90_ew = ew;
    }
  }
  return rows;
}

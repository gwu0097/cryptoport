// Pure per-asset metrics + kill-filter gates for one snapshot (Phase 2a) —
// see metrics.test.ts. Null is never 0 (principle #2): every ratio is null
// when an input is null or its denominator isn't positive (a P/S with zero
// revenue is undefined, not infinite). History-derived metrics (momentum,
// beta, dilution, revenue growth/collapse) come from history.ts (Phase 2b)
// and are passed in; without them those fields are null and the revenue-
// collapse gate is not evaluable.

import { SCREENER_CONFIG, sectorBucketFor, type ScreenerConfig, type SectorBucket } from "./config.ts";
import type { HistoryMetrics } from "./history.ts";

export interface SnapshotForMetrics {
  asset_id: string;
  gecko_id: string;
  sector: string | null; // DefiLlama category of the asset's highest-revenue child protocol
  price_usd: number | null;
  market_cap_usd: number | null;
  fdv_usd: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  max_supply: number | null;
  tvl_usd: number | null;
  fees_30d: number | null;
  revenue_30d: number | null;
  holders_revenue_30d: number | null;
  volume_24h_usd: number | null;
}

export type GateResult = "pass" | "fail" | "not_evaluable";

export interface GateStatus {
  core_data: GateResult;
  out_of_scope: GateResult;
  mcap_floor: GateResult;
  liquidity: GateResult;
  revenue_floor: GateResult;
  unlock_overhang: GateResult;
  collapsing_revenue: GateResult;
}

export interface AssetMetrics extends HistoryMetrics {
  asset_id: string;
  sector_bucket: SectorBucket;
  fees_ann: number | null;
  rev_ann: number | null;
  holders_rev_ann: number | null;
  pf_fd: number | null;
  pf_circ: number | null;
  ps_fd: number | null;
  ps_circ: number | null;
  capture: number | null;
  buyback_yield: number | null;
  float_ratio: number | null;
  mc_tvl: number | null;
  size_log_mcap: number | null;
  rated: boolean;
  gate_status: GateStatus;
}

const ANNUALIZE = 365 / 30;

const annualize = (v30: number | null): number | null => (v30 === null ? null : v30 * ANNUALIZE);

/** a / b, or null when either is unknown or b isn't positive. */
export function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !(b > 0)) return null;
  return a / b;
}

/** threshold check on a possibly-null value: null -> not_evaluable. */
const atLeast = (v: number | null, min: number): GateResult => (v === null ? "not_evaluable" : v >= min ? "pass" : "fail");

const NO_HISTORY: HistoryMetrics = {
  mom_3w: null,
  mom_12w: null,
  beta_btc: null,
  rev_growth: null,
  rev_90d_change: null,
  dilution_rate: null,
  dilution_rate_implied: null,
};

export function computeAssetMetrics(
  s: SnapshotForMetrics,
  config: ScreenerConfig = SCREENER_CONFIG,
  history: HistoryMetrics = NO_HISTORY,
): AssetMetrics {
  // A per-asset scope override (config.scopeOverrides) wins over the
  // category mapping — see the config for why the category can't catch it.
  const scopeOverride = (config.scopeOverrides as Record<string, { bucket: SectorBucket }>)[s.gecko_id];
  const sectorBucket = scopeOverride ? scopeOverride.bucket : sectorBucketFor(s.sector, config);
  const feesAnn = annualize(s.fees_30d);
  const revAnn = annualize(s.revenue_30d);
  const holdersRevAnn = annualize(s.holders_revenue_30d);

  // DefiLlama's dailyHoldersRevenue is a literal 0 both for "no mechanism"
  // and "not tracked" — only trusted for assets with a documented mechanism.
  const hasMechanism = Object.hasOwn(config.holderValueMechanisms, s.gecko_id);
  const supplyCap = s.max_supply ?? s.total_supply;

  const gate_status: GateStatus = {
    core_data: s.price_usd !== null && s.market_cap_usd !== null && s.revenue_30d !== null ? "pass" : "fail",
    out_of_scope: sectorBucket === "out_of_scope" ? "fail" : "pass",
    mcap_floor: atLeast(s.market_cap_usd, config.gates.mcapFloorUsd),
    liquidity: atLeast(s.volume_24h_usd, config.gates.minVolume24hUsd),
    revenue_floor: atLeast(revAnn, config.gates.minRevenueAnnualizedUsd),
    unlock_overhang: "not_evaluable", // no forward unlock data source yet
    // 90d revenue vs the prior 90d; null (too little history) -> not_evaluable.
    collapsing_revenue:
      history.rev_90d_change === null
        ? "not_evaluable"
        : history.rev_90d_change < config.gates.collapsingRevenue90d.unratedBelow
          ? "fail"
          : "pass",
  };

  return {
    asset_id: s.asset_id,
    sector_bucket: sectorBucket,
    fees_ann: feesAnn,
    rev_ann: revAnn,
    holders_rev_ann: holdersRevAnn,
    pf_fd: ratio(s.fdv_usd, feesAnn),
    pf_circ: ratio(s.market_cap_usd, feesAnn),
    ps_fd: ratio(s.fdv_usd, revAnn),
    ps_circ: ratio(s.market_cap_usd, revAnn),
    capture: hasMechanism ? ratio(s.holders_revenue_30d, s.revenue_30d) : null,
    buyback_yield: hasMechanism ? ratio(holdersRevAnn, s.market_cap_usd) : null,
    float_ratio: ratio(s.circulating_supply, supplyCap),
    mc_tvl: (config.mcTvlBuckets as readonly string[]).includes(sectorBucket) ? ratio(s.market_cap_usd, s.tvl_usd) : null,
    size_log_mcap: s.market_cap_usd !== null && s.market_cap_usd > 0 ? Math.log(s.market_cap_usd) : null,
    ...history,
    rated: !Object.values(gate_status).includes("fail"),
    gate_status,
  };
}

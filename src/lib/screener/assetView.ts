import "server-only";
import { serviceDb } from "@/lib/supabase";
import { loadLatestDailyRun, type TierValue } from "./queries";
import { dailyReadings, type Reading } from "./history";
import { sourceChanges } from "./sourceChanges";

// One asset's Fundamentals, for the Encyclopedia's Fundamentals tab — a lens
// over what the daily job already computed (latest daily run's snapshot,
// metrics and Quality & Risk tier, plus the stored snapshot history). No new
// metric, no network call. Deliberately NOT read: grades, timing scores,
// setup tags or any rank — those stay behind /screener's experimental toggle
// (SPEC "Product": the backtest found no predictive value, so a grade on a
// coin's page would imply an order the evidence doesn't support).

export interface AssetFundamentals {
  asset: { id: string; geckoId: string; name: string; ticker: string; sector: string | null; defillamaSlug: string | null };
  run: { id: string; startedAt: string; degraded: boolean } | null;
  /** The asset's row in that run (null: the asset had no snapshot in the latest run). */
  snapshot: {
    observedAt: string;
    isBackfilled: boolean;
    priceUsd: number | null;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    circulatingSupply: number | null;
    totalSupply: number | null;
    maxSupply: number | null;
    tvlUsd: number | null;
    volume24hUsd: number | null;
    fees30d: number | null;
    revenue30d: number | null;
    holdersRevenue30d: number | null;
    /** DefiLlama slugs whose fees/revenue were summed into this asset (primary first). */
    contributingSlugs: string[];
  } | null;
  metrics: {
    rated: boolean;
    gateStatus: Record<string, string>;
    sectorBucket: string | null;
    feesAnn: number | null;
    revAnn: number | null;
    holdersRevAnn: number | null;
    psCirc: number | null;
    psFd: number | null;
    pfCirc: number | null;
    pfFd: number | null;
    capture: number | null;
    buybackYield: number | null;
    floatRatio: number | null;
    mcTvl: number | null;
    mom3w: number | null;
    mom12w: number | null;
    betaBtc: number | null;
    dilutionRate: number | null;
    dilutionRateImplied: number | null;
    revGrowth: number | null;
    rev90dChange: number | null;
  } | null;
  tier: { value: TierValue; rules: { rule: string; fired: boolean | null }[]; rulesEvaluable: number } | null;
  /** Field disagreements between sources flagged in this run (e.g. market cap). */
  conflicts: { field: string; sourceA: string; valueA: number | null; sourceB: string; valueB: number | null; pctDiff: number | null }[];
  /** One point per UTC day (the day's reading by the shared rule), oldest first. */
  history: { date: string; fees30d: number | null; revenue30d: number | null; holdersRevenue30d: number | null; marketCapUsd: number | null; isBackfilled: boolean }[];
  /** Days where the set of DefiLlama sources summed into this asset changed
   * (e.g. the 2026-09-24 FlowSwap exclusion from FLOW): a step in the chart
   * there is an attribution change, not a change in activity. */
  sourceChanges: { date: string; added: string[]; removed: string[] }[];
}

type SnapRow = {
  observed_at: string;
  is_backfilled: boolean;
  price_usd: number | null;
  market_cap_usd: number | null;
  fdv_usd: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  max_supply: number | null;
  tvl_usd: number | null;
  volume_24h_usd: number | null;
  fees_30d: number | null;
  revenue_30d: number | null;
  holders_revenue_30d: number | null;
  contributing_slugs: string[] | null;
  run_id: string | null;
  screener_runs: { status: string; degraded: boolean | null } | null;
};

/** null = this coin isn't in the Fundamentals universe at all. */
export async function getAssetFundamentals(geckoId: string): Promise<AssetFundamentals | null> {
  const db = serviceDb();
  const { data: assetRow, error: assetError } = await db
    .from("screener_assets")
    .select("id, gecko_id, name, ticker, sector, defillama_slug")
    .eq("gecko_id", geckoId)
    .maybeSingle();
  if (assetError) throw new Error(`Failed to load screener_assets(${geckoId}): ${assetError.message}`);
  if (!assetRow) return null;
  const asset = {
    id: assetRow.id as string,
    geckoId: assetRow.gecko_id as string,
    name: assetRow.name as string,
    ticker: assetRow.ticker as string,
    sector: (assetRow.sector as string | null) ?? null,
    defillamaSlug: (assetRow.defillama_slug as string | null) ?? null,
  };

  // Every stored snapshot for the asset (a few hundred to ~1,200 rows), paged.
  const snaps: SnapRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("screener_asset_snapshots")
      .select(
        "observed_at, is_backfilled, price_usd, market_cap_usd, fdv_usd, circulating_supply, total_supply, max_supply, tvl_usd, volume_24h_usd, fees_30d, revenue_30d, holders_revenue_30d, contributing_slugs, run_id, screener_runs(status, degraded)",
      )
      .eq("asset_id", asset.id)
      .order("observed_at")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to load screener_asset_snapshots(${geckoId}): ${error.message}`);
    snaps.push(...((data ?? []) as unknown as SnapRow[]));
    if (!data || data.length < 1000) break;
  }
  // Backfilled rows belong to backfill runs; live rows count only from ok runs.
  const usable = snaps.filter((s) => s.is_backfilled || s.screener_runs?.status === "ok");
  const readings = usable.map((s) => ({ ...s, degraded: !!s.screener_runs?.degraded })) as unknown as (Reading & SnapRow)[];
  const byDay = dailyReadings(readings, new Date().toISOString()) as Map<string, Reading & SnapRow>;
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const changes = sourceChanges(days.map(([date, s]) => [date, s.contributing_slugs] as const));
  const history = days
    .map(([date, s]) => ({
      date,
      fees30d: s.fees_30d,
      revenue30d: s.revenue_30d,
      holdersRevenue30d: s.holders_revenue_30d,
      marketCapUsd: s.market_cap_usd,
      isBackfilled: s.is_backfilled,
    }));

  const run = await loadLatestDailyRun();
  const base: AssetFundamentals = { asset, run: null, snapshot: null, metrics: null, tier: null, conflicts: [], history, sourceChanges: changes };
  if (!run) return base;
  base.run = { id: run.id, startedAt: run.started_at, degraded: !!run.degraded };

  const s = snaps.find((x) => x.run_id === run.id);
  if (s) {
    base.snapshot = {
      observedAt: s.observed_at,
      isBackfilled: s.is_backfilled,
      priceUsd: s.price_usd,
      marketCapUsd: s.market_cap_usd,
      fdvUsd: s.fdv_usd,
      circulatingSupply: s.circulating_supply,
      totalSupply: s.total_supply,
      maxSupply: s.max_supply,
      tvlUsd: s.tvl_usd,
      volume24hUsd: s.volume_24h_usd,
      fees30d: s.fees_30d,
      revenue30d: s.revenue_30d,
      holdersRevenue30d: s.holders_revenue_30d,
      contributingSlugs: s.contributing_slugs ?? [],
    };
  }

  const [{ data: m, error: mError }, { data: t, error: tError }, { data: c, error: cError }] = await Promise.all([
    db
      .from("screener_asset_metrics")
      .select(
        "rated, gate_status, sector_bucket, fees_ann, rev_ann, holders_rev_ann, ps_circ, ps_fd, pf_circ, pf_fd, capture, buyback_yield, float_ratio, mc_tvl, mom_3w, mom_12w, beta_btc, dilution_rate, dilution_rate_implied, rev_growth, rev_90d_change",
      )
      .eq("run_id", run.id)
      .eq("asset_id", asset.id)
      .maybeSingle(),
    db
      .from("screener_asset_scores")
      .select("quality_risk_tier, quality_risk_rules, rules_evaluable")
      .eq("run_id", run.id)
      .eq("asset_id", asset.id)
      .maybeSingle(),
    db
      .from("screener_field_conflicts")
      .select("field_name, source_a, value_a, source_b, value_b, pct_diff")
      .eq("run_id", run.id)
      .eq("asset_id", asset.id),
  ]);
  if (mError) throw new Error(`Failed to load screener_asset_metrics(${geckoId}): ${mError.message}`);
  if (tError) throw new Error(`Failed to load screener_asset_scores(${geckoId}): ${tError.message}`);
  if (cError) throw new Error(`Failed to load screener_field_conflicts(${geckoId}): ${cError.message}`);
  if (m) {
    base.metrics = {
      rated: m.rated,
      gateStatus: (m.gate_status ?? {}) as Record<string, string>,
      sectorBucket: m.sector_bucket,
      feesAnn: m.fees_ann,
      revAnn: m.rev_ann,
      holdersRevAnn: m.holders_rev_ann,
      psCirc: m.ps_circ,
      psFd: m.ps_fd,
      pfCirc: m.pf_circ,
      pfFd: m.pf_fd,
      capture: m.capture,
      buybackYield: m.buyback_yield,
      floatRatio: m.float_ratio,
      mcTvl: m.mc_tvl,
      mom3w: m.mom_3w,
      mom12w: m.mom_12w,
      betaBtc: m.beta_btc,
      dilutionRate: m.dilution_rate,
      dilutionRateImplied: m.dilution_rate_implied,
      revGrowth: m.rev_growth,
      rev90dChange: m.rev_90d_change,
    };
  }
  if (t) {
    base.tier = {
      value: t.quality_risk_tier as TierValue,
      rules: (t.quality_risk_rules ?? []) as { rule: string; fired: boolean | null }[],
      rulesEvaluable: t.rules_evaluable as number,
    };
  }
  base.conflicts = (c ?? []).map((x) => ({
    field: x.field_name as string,
    sourceA: x.source_a as string,
    valueA: x.value_a as number | null,
    sourceB: x.source_b as string,
    valueB: x.value_b as number | null,
    pctDiff: x.pct_diff as number | null,
  }));
  return base;
}

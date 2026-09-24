import "server-only";
import { serviceDb } from "@/lib/supabase";
import { fetchAllRows } from "./pagination";
import { latestDailyRun, type RunRow } from "./runSelection";

export interface UniverseRow {
  assetId: string;
  geckoId: string;
  defillamaSlug: string | null;
  name: string;
  ticker: string;
  sector: string | null;
  status: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  tvlUsd: number | null;
  fees30d: number | null;
  revenue30d: number | null;
  holdersRevenue30d: number | null;
  volume24hUsd: number | null;
  observedAt: string;
  isBackfilled: boolean;
  hasConflict: boolean;
}

export interface UniverseSnapshotResult {
  runId: string | null;
  runStartedAt: string | null;
  rows: UniverseRow[];
  unmatchedCount: number;
  conflictCount: number;
}

/**
 * The Phase 1 "read-only table view of the raw universe" deliverable —
 * spot-check surface, not the real screener UI (that's Phase 3+, once
 * grades/tiers/setup-tags exist). Reads the most recent successful run's
 * snapshot rows directly by `run_id` rather than a DISTINCT-ON-style
 * "latest observation per asset" query — the daily job writes exactly one
 * row per matched asset per run, so filtering by the latest `status='ok'`
 * run's id already gives "today's snapshot" without needing a more complex
 * per-asset-latest query. That more complex query becomes necessary once
 * point-in-time backtesting (Phase 4) needs "the value as of date D" for
 * an arbitrary historical D — not needed yet.
 */
export async function getLatestUniverseSnapshot(): Promise<UniverseSnapshotResult> {
  const db = serviceDb();

  // Same one-run-per-day rule as the screener (runSelection.ts).
  const { data: recentRuns, error: runError } = await db
    .from("screener_runs")
    .select("id, started_at, status, kind, degraded, unmatched_count, notes")
    .eq("kind", "live") // backfill runs also land in screener_runs now
    .order("started_at", { ascending: false })
    .limit(30);
  if (runError) throw new Error(`Failed to load latest screener_runs: ${runError.message}`);
  const runRow = latestDailyRun((recentRuns ?? []) as (RunRow & { unmatched_count: number | null })[]);
  if (!runRow) return { runId: null, runStartedAt: null, rows: [], unmatchedCount: 0, conflictCount: 0 };

  const runId = runRow.id as string;

  // Paginated (see pagination.ts's own doc comment) — the universe is
  // already at 682 matched assets and growing, well within reach of
  // PostgREST's 1,000-row default select cap.
  type RawSnapshotRow = {
    id: string;
    asset_id: string;
    observed_at: string;
    is_backfilled: boolean;
    price_usd: number | null;
    market_cap_usd: number | null;
    fdv_usd: number | null;
    tvl_usd: number | null;
    fees_30d: number | null;
    revenue_30d: number | null;
    holders_revenue_30d: number | null;
    volume_24h_usd: number | null;
    screener_assets: { gecko_id: string; defillama_slug: string | null; name: string; ticker: string; sector: string | null; status: string } | null;
  };
  const snapshotRows = await fetchAllRows<RawSnapshotRow>(async (cursor, limit) => {
    // Supabase's own type inference treats an embedded relation
    // (screener_assets(...)) as an array even though `screener_assets`'
    // gecko_id is unique (a genuine one-to-one from this table's side) —
    // cast past it rather than fight the inference, same as the original
    // pre-pagination version of this query did.
    const result = await db
      .from("screener_asset_snapshots")
      .select(
        "id, asset_id, observed_at, is_backfilled, price_usd, market_cap_usd, fdv_usd, tvl_usd, fees_30d, revenue_30d, holders_revenue_30d, volume_24h_usd, screener_assets(gecko_id, defillama_slug, name, ticker, sector, status)",
      )
      .eq("run_id", runId)
      .gt("id", cursor)
      .order("id")
      .limit(limit);
    return result as unknown as { data: RawSnapshotRow[] | null; error: { message: string } | null };
  });

  const conflictRows = await fetchAllRows<{ id: string; asset_id: string }>(async (cursor, limit) =>
    db
      .from("screener_field_conflicts")
      .select("id, asset_id")
      .eq("run_id", runId)
      .gt("id", cursor)
      .order("id")
      .limit(limit),
  );
  const conflictedAssetIds = new Set(conflictRows.map((r) => r.asset_id));

  const rows: UniverseRow[] = snapshotRows
    .filter((r) => r.screener_assets !== null)
    .map((r) => ({
      assetId: r.asset_id,
      geckoId: r.screener_assets!.gecko_id,
      defillamaSlug: r.screener_assets!.defillama_slug,
      name: r.screener_assets!.name,
      ticker: r.screener_assets!.ticker,
      sector: r.screener_assets!.sector,
      status: r.screener_assets!.status,
      priceUsd: r.price_usd,
      marketCapUsd: r.market_cap_usd,
      fdvUsd: r.fdv_usd,
      tvlUsd: r.tvl_usd,
      fees30d: r.fees_30d,
      revenue30d: r.revenue_30d,
      holdersRevenue30d: r.holders_revenue_30d,
      volume24hUsd: r.volume_24h_usd,
      observedAt: r.observed_at,
      isBackfilled: r.is_backfilled,
      hasConflict: conflictedAssetIds.has(r.asset_id),
    }));

  return {
    runId,
    runStartedAt: runRow.started_at as string,
    rows,
    unmatchedCount: (runRow.unmatched_count as number) ?? 0,
    conflictCount: conflictedAssetIds.size,
  };
}

// ---------------------------------------------------------------------------
// Phase 3b: the screener page's data — one run's scores, regime and gates.

export type SetupTagValue = "LEADER" | "WATCH" | "SPECULATIVE" | "AVOID" | "NEUTRAL";
export type TierValue = "pass" | "caution" | "high_risk";

export interface ScreenerRow {
  assetId: string;
  geckoId: string;
  name: string;
  ticker: string;
  sectorBucket: string | null;
  marketCapUsd: number | null;
  mom3w: number | null;
  mom12w: number | null;
  tier: TierValue;
  rulesEvaluable: number;
  firedRules: string[];
  timingScore: number | null;
  timingPercentile: number | null;
  gradeRaw: string | null;
  grade: string | null;
  tercile: number | null;
  tag: SetupTagValue | null;
  confidence: "high" | "medium" | "low";
  sizeBucket: string | null;
  sourceConflict: boolean;
}

/** One asset in the default research view: verified fundamentals, kill
 * filters, risk tier, valuation and momentum as plain columns — no grade,
 * tag or ranked order (those are behind the experimental toggle; SPEC:
 * the screener is a verified research dataset with a risk filter, not a
 * signal). */
export interface ResearchRow {
  assetId: string;
  geckoId: string;
  name: string;
  ticker: string;
  /** Passed every kill filter. */
  rated: boolean;
  /** Kill filters this asset failed (empty when rated). */
  failedGates: string[];
  sectorBucket: string | null;
  revAnn: number | null;
  feesAnn: number | null;
  marketCapUsd: number | null;
  psCirc: number | null;
  pfCirc: number | null;
  capture: number | null;
  buybackYield: number | null;
  mom3w: number | null;
  mom12w: number | null;
  betaBtc: number | null;
  /** Quality & Risk tier — computed for rated assets only. */
  tier: TierValue | null;
  rulesEvaluable: number | null;
  firedRules: string[];
  sourceConflict: boolean;
}

export interface RegimeRule {
  rule: string;
  fired: boolean | null;
  inputs: Record<string, number | null>;
}

export interface ScreenerView {
  run: {
    id: string;
    startedAt: string;
    trigger: string | null;
    configVersionId: string | null;
    /** CoinGecko was unavailable: market cap/supply/volume null, nothing rated. */
    degraded: { error: string; pricesMissing: number } | null;
  } | null;
  /** The default view: every asset in the run (filter on `rated`). */
  research: ResearchRow[];
  /** EXPERIMENTAL view — rated assets with both momentum legs: graded, tagged, ranked. */
  graded: ScreenerRow[];
  /** Rated assets with one momentum leg: scored and placed, never graded or tagged. */
  insufficientHistory: ScreenerRow[];
  /** Rated assets with no momentum leg at all. */
  unscoredCount: number;
  ratedCount: number;
  unrated: { total: number; failedByGate: Record<string, number> };
  regime: { label: string; rules: RegimeRule[]; computedAt: string } | null;
  sizeCheck: { top_tercile_n: number; counts: Record<string, number>; dominant: string | null; share: number | null; flagged: boolean } | null;
  /** Why this run has no scores, when it has none (still computing, or a failed step). */
  scoresMissingReason: string | null;
}

export type LatestRun = RunRow & { notes: Record<string, unknown> | null };

/** The latest day's representative live run — by the one shared rule
 * (runSelection.ts; SPEC "One run per UTC day") — or null. Shared by
 * /screener and the Encyclopedia's Fundamentals tab, so both always show
 * the same run. */
export async function loadLatestDailyRun(): Promise<LatestRun | null> {
  // Enough recent runs to cover the latest day even with several manual runs.
  const { data: runs, error } = await serviceDb()
    .from("screener_runs")
    .select("id, started_at, status, kind, degraded, notes")
    .eq("kind", "live")
    .order("started_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(`Failed to load screener_runs: ${error.message}`);
  return latestDailyRun((runs ?? []) as LatestRun[]);
}

/** The screener page's view of the latest day's run — the day's run picked
 * by the one shared rule (runSelection.ts; SPEC "One run per UTC day"). If
 * that run has no scores yet (derivations run ~1 minute after it turns ok)
 * or its scoring step failed, the page says so; it never falls back to an
 * earlier run, which would be a different snapshot shown as today's. */
export async function getScreenerView(): Promise<ScreenerView> {
  const db = serviceDb();
  const empty: ScreenerView = {
    run: null, research: [], graded: [], insufficientHistory: [], unscoredCount: 0, ratedCount: 0,
    unrated: { total: 0, failedByGate: {} }, regime: null, sizeCheck: null, scoresMissingReason: null,
  };

  const run = await loadLatestDailyRun();
  if (!run) return empty;

  const notes = (run.notes ?? {}) as {
    trigger?: string;
    derivations?: { config_version_id?: string; scores?: { size_check?: ScreenerView["sizeCheck"] }; scores_error?: string; metrics_error?: string };
    degradation?: { error: string; prices_missing: number };
  };
  const view: ScreenerView = {
    ...empty,
    run: {
      id: run.id,
      startedAt: run.started_at,
      trigger: notes.trigger ?? null,
      configVersionId: notes.derivations?.config_version_id ?? null,
      degraded: run.degraded ? { error: notes.degradation?.error ?? "unknown", pricesMissing: notes.degradation?.prices_missing ?? 0 } : null,
    },
    sizeCheck: notes.derivations?.scores?.size_check ?? null,
  };

  type MetricRow = {
    asset_id: string; rated: boolean; gate_status: Record<string, string>; sector_bucket: string | null;
    mom_3w: number | null; mom_12w: number | null; size_log_mcap: number | null; beta_btc: number | null;
    fees_ann: number | null; rev_ann: number | null; ps_circ: number | null; pf_circ: number | null;
    capture: number | null; buyback_yield: number | null;
    screener_assets: { gecko_id: string; name: string; ticker: string } | null;
  };
  const metrics: MetricRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("screener_asset_metrics")
      .select("asset_id, rated, gate_status, sector_bucket, mom_3w, mom_12w, size_log_mcap, beta_btc, fees_ann, rev_ann, ps_circ, pf_circ, capture, buyback_yield, screener_assets(gecko_id, name, ticker)")
      .eq("run_id", run.id)
      .order("asset_id")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to load screener_asset_metrics: ${error.message}`);
    metrics.push(...((data ?? []) as unknown as MetricRow[]));
    if (!data || data.length < 1000) break;
  }
  const unrated = metrics.filter((m) => !m.rated);
  const failedByGate: Record<string, number> = {};
  for (const m of unrated) for (const [gate, result] of Object.entries(m.gate_status)) if (result === "fail") failedByGate[gate] = (failedByGate[gate] ?? 0) + 1;
  view.unrated = { total: unrated.length, failedByGate };
  view.ratedCount = metrics.length - unrated.length;

  const { data: conflictRows, error: conflictError } = await db.from("screener_field_conflicts").select("asset_id").eq("run_id", run.id);
  if (conflictError) throw new Error(`Failed to load screener_field_conflicts: ${conflictError.message}`);
  const conflicted = new Set((conflictRows ?? []).map((c) => c.asset_id as string));
  view.research = metrics
    .filter((m) => m.screener_assets !== null)
    .map((m) => ({
      assetId: m.asset_id,
      geckoId: m.screener_assets!.gecko_id,
      name: m.screener_assets!.name,
      ticker: m.screener_assets!.ticker,
      rated: m.rated,
      failedGates: Object.entries(m.gate_status).filter(([, r]) => r === "fail").map(([g]) => g),
      sectorBucket: m.sector_bucket,
      revAnn: m.rev_ann,
      feesAnn: m.fees_ann,
      marketCapUsd: m.size_log_mcap != null ? Math.exp(m.size_log_mcap) : null,
      psCirc: m.ps_circ,
      pfCirc: m.pf_circ,
      capture: m.capture,
      buybackYield: m.buyback_yield,
      mom3w: m.mom_3w,
      mom12w: m.mom_12w,
      betaBtc: m.beta_btc,
      tier: null,
      rulesEvaluable: null,
      firedRules: [],
      sourceConflict: conflicted.has(m.asset_id),
    }));

  const { data: regime, error: regimeError } = await db
    .from("screener_regime_snapshots")
    .select("label, rules, computed_at")
    .eq("run_id", run.id)
    .maybeSingle();
  if (regimeError) throw new Error(`Failed to load screener_regime_snapshots: ${regimeError.message}`);
  if (regime) view.regime = { label: regime.label as string, rules: regime.rules as RegimeRule[], computedAt: regime.computed_at as string };

  type ScoreRow = {
    asset_id: string; quality_risk_tier: TierValue; quality_risk_rules: { rule: string; fired: boolean | null }[]; rules_evaluable: number;
    timing_score: number | null; timing_percentile: number | null; timing_grade_raw: string | null; timing_grade: string | null;
    momentum_tercile: number | null; setup_tag: SetupTagValue | null; confidence: ScreenerRow["confidence"]; size_bucket: string | null;
    score_breakdown: { legs_used: number; insufficient_history?: boolean; source_conflict: boolean };
    screener_assets: { gecko_id: string; name: string; ticker: string } | null;
  };
  const { data: scoreData, error: scoresError } = await db
    .from("screener_asset_scores")
    .select(
      "asset_id, quality_risk_tier, quality_risk_rules, rules_evaluable, timing_score, timing_percentile, timing_grade_raw, timing_grade, momentum_tercile, setup_tag, confidence, size_bucket, score_breakdown, screener_assets(gecko_id, name, ticker)",
    )
    .eq("run_id", run.id);
  if (scoresError) throw new Error(`Failed to load screener_asset_scores: ${scoresError.message}`);
  const scores = (scoreData ?? []) as unknown as ScoreRow[];
  if (scores.length === 0) {
    const d = notes.derivations;
    view.scoresMissingReason = run.degraded
      ? "Nothing is rated for this day: CoinGecko was unavailable, so market cap, supply and volume weren't recorded (see the notice above)."
      : d?.scores_error
      ? `Scoring failed for this run: ${d.scores_error}`
      : d?.metrics_error
        ? `Metrics failed for this run, so nothing was scored: ${d.metrics_error}`
        : d
          ? "This run has no rated assets to score."
          : "Scores for this run are still being computed (about a minute after the snapshot finishes). Reload shortly.";
    return view;
  }

  const researchById = new Map(view.research.map((r) => [r.assetId, r]));
  for (const sc of scores) {
    const r = researchById.get(sc.asset_id);
    if (!r) continue;
    r.tier = sc.quality_risk_tier;
    r.rulesEvaluable = sc.rules_evaluable;
    r.firedRules = sc.quality_risk_rules.filter((x) => x.fired === true).map((x) => x.rule);
  }
  const metricById = new Map(metrics.map((m) => [m.asset_id, m]));
  const rows: ScreenerRow[] = scores
    .filter((s) => s.screener_assets !== null)
    .map((s) => {
      const m = metricById.get(s.asset_id);
      return {
        assetId: s.asset_id,
        geckoId: s.screener_assets!.gecko_id,
        name: s.screener_assets!.name,
        ticker: s.screener_assets!.ticker,
        sectorBucket: m?.sector_bucket ?? null,
        marketCapUsd: m?.size_log_mcap != null ? Math.exp(m.size_log_mcap) : null,
        mom3w: m?.mom_3w ?? null,
        mom12w: m?.mom_12w ?? null,
        tier: s.quality_risk_tier,
        rulesEvaluable: s.rules_evaluable,
        firedRules: s.quality_risk_rules.filter((r) => r.fired === true).map((r) => r.rule),
        timingScore: s.timing_score,
        timingPercentile: s.timing_percentile,
        gradeRaw: s.timing_grade_raw,
        grade: s.timing_grade,
        tercile: s.momentum_tercile,
        tag: s.setup_tag,
        confidence: s.confidence,
        sizeBucket: s.size_bucket,
        sourceConflict: s.score_breakdown.source_conflict,
      };
    });
  view.graded = rows.filter((r) => r.tag !== null);
  view.insufficientHistory = rows
    .filter((r) => r.tag === null && r.timingScore !== null)
    .sort((a, b) => (b.timingPercentile ?? 0) - (a.timingPercentile ?? 0));
  view.unscoredCount = rows.filter((r) => r.timingScore === null).length;
  return view;
}

/** The latest completed Phase 4 backtest's one-line conclusion
 * (screener_backtest_runs.notes), for the caption under the "Unvalidated"
 * banner. Read from the DB, not hard-coded, so a later run replaces it
 * instead of leaving a stale claim on the page. */
export async function getLatestBacktestSummary(): Promise<{ id: string; finishedAt: string; summary: string } | null> {
  const { data, error } = await serviceDb()
    .from("screener_backtest_runs")
    .select("id, finished_at, notes")
    .eq("status", "ok")
    .not("notes", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load screener_backtest_runs: ${error.message}`);
  return data ? { id: data.id as string, finishedAt: data.finished_at as string, summary: data.notes as string } : null;
}

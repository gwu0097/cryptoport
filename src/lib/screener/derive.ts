import "server-only";
import { serviceDb } from "@/lib/supabase";
import { SCREENER_CONFIG, configHash, validateConfig } from "./config";
import { computeAssetMetrics, type SnapshotForMetrics } from "./metrics";
import { evaluateRegime, percentileOf, oneValuePerDay, type RegimeInputs } from "./regime";
import { fetchBtcDominancePct } from "./adapters/coingecko";
import { fetchStablecoinSupply, fetchStablecoinDailyChange } from "./adapters/defillama";
import { fetchPricesAt, fetchChartPrices } from "./adapters/defillamaPrices";
import { computeHistoryMetrics, shiftDate, type Reading, type BtcReference } from "./history";
import { fetchAllRows } from "./pagination";
import { checkPlausibility, type PlausibilityWarning } from "./plausibility";
import { fetchPerpContexts } from "./adapters/hyperliquid";
import { scoreRun, type ScoreInput, type RunScores } from "./scores";
import type { RegimeLabel } from "./regime";

// Everything derived from a finished live snapshot run — per-asset metrics +
// kill-filter gates (2a/2b), the market regime (2a), and tiers/Score B/
// grades/setup tags (Phase 3) — stamped with the
// config version that produced them. Runs after runScreenerSnapshot in the
// same cron invocation; each step is isolated so a failure here never
// affects the snapshot itself (point-in-time rows are the irreplaceable
// part; everything here can be recomputed from them + the versioned config).

const WRITE_CHUNK = 500;
const DAY_MS = 86_400_000;

/** The screener_scoring_config_versions row for the current config, created
 * on first use. Config validity is checked before anything is recorded. */
export async function ensureConfigVersion(): Promise<string> {
  validateConfig(SCREENER_CONFIG);
  const db = serviceDb();
  const hash = configHash(SCREENER_CONFIG);
  const existing = await db.from("screener_scoring_config_versions").select("id").eq("config_hash", hash).maybeSingle();
  if (existing.error) throw new Error(`Failed to read config versions: ${existing.error.message}`);
  if (existing.data) return existing.data.id as string;

  const inserted = await db
    .from("screener_scoring_config_versions")
    .insert({ config_hash: hash, config: SCREENER_CONFIG })
    .select("id")
    .single();
  if (!inserted.error) return inserted.data.id as string;
  // A concurrent run inserted the same hash first — use its row.
  if (inserted.error.code !== "23505") throw new Error(`Failed to record config version: ${inserted.error.message}`);
  const again = await db.from("screener_scoring_config_versions").select("id").eq("config_hash", hash).single();
  if (again.error) throw new Error(`Failed to read config version after race: ${again.error.message}`);
  return again.data.id as string;
}

export type HistoryRow = Reading & { id: string; asset_id: string; provenance_override?: { price_usd?: { source?: string } } | null };

const HISTORY_SELECT =
  "id, asset_id, observed_at, is_backfilled, run_id, price_usd, market_cap_usd, circulating_supply, revenue_30d, provenance_override";

/** Every stored reading an asset's 2b metrics can need, up to `asOf`:
 * the last ~95 days in full (beta 90d, momentum 84d, dilution 90d, revenue
 * t/-30/-60/-90), plus the two older revenue checkpoints (t-120, t-150)
 * as narrow date windows instead of reading ~155 days of rows. */
export async function loadHistoryReadings(asOf: string): Promise<{ rows: HistoryRow[]; ms: number }> {
  const t0 = Date.now();
  const db = serviceDb();
  const tol = SCREENER_CONFIG.history.lookbackToleranceDays;
  const end = asOf.slice(0, 10);
  const ranges: [string, string][] = [[`${shiftDate(end, -95)}T00:00:00Z`, asOf]];
  for (const back of [120, 150]) {
    ranges.push([`${shiftDate(end, -back - tol)}T00:00:00Z`, `${shiftDate(end, -back + tol + 1)}T00:00:00Z`]);
  }
  const rows: HistoryRow[] = [];
  for (const [from, to] of ranges) {
    rows.push(
      ...(await fetchAllRows<HistoryRow>(async (cursor, limit) => {
        const res = await db
          .from("screener_asset_snapshots")
          .select(HISTORY_SELECT)
          .gte("observed_at", from)
          .lte("observed_at", to)
          .gt("id", cursor)
          .order("id")
          .limit(limit);
        return res as unknown as { data: HistoryRow[] | null; error: { message: string } | null };
      })),
    );
  }
  for (const r of rows) r.price_from_coingecko = r.is_backfilled && r.provenance_override?.price_usd?.source === "coingecko";
  // Readings from degraded runs (CoinGecko unavailable) lose to a complete
  // reading of the same day in dailyReadings — same rule as runSelection.ts.
  const { data: degradedRuns, error: degradedError } = await db
    .from("screener_runs")
    .select("id")
    .eq("kind", "live")
    .eq("degraded", true)
    .gte("started_at", ranges[ranges.length - 1][0]);
  if (degradedError) throw new Error(`Failed to read degraded runs: ${degradedError.message}`);
  const degradedIds = new Set((degradedRuns ?? []).map((r) => r.id as string));
  for (const r of rows) r.degraded = degradedIds.has(r.run_id);
  return { rows, ms: Date.now() - t0 };
}

/** BTC read at the same moments as the asset readings (see BtcReference in
 * history.ts for why "daily point" isn't a moment):
 * - each backfill run's rows: BTC from /chart started at that run's time of
 *   day (its window started when it did, so its points sit on that grid);
 * - CoinGecko-priced backfilled rows: BTC at 00:00 UTC;
 * - live runs: the same-moment price in the run's notes (stored by the
 *   snapshot job since 2b, from the same CoinGecko response as the assets);
 *   older runs get DefiLlama's BTC at their exact observed_at, written back
 *   into their notes so it's fetched only once. */
export async function loadBtcReference(
  asOf: string,
  liveRuns: Map<string, string>,
  backfillRunIds: Set<string>,
  /** How far back the BTC grids reach. 100 covers the daily run's windows;
   * Phase 4's backtest passes a full year (it scores many past dates). */
  daysBack = 100,
): Promise<{ btc: BtcReference; ms: number; backfilledRuns: number; grids: number }> {
  const t0 = Date.now();
  const db = serviceDb();
  const firstDate = shiftDate(asOf.slice(0, 10), -daysBack);
  const chartFrom = async (timeOfDay: string) => {
    const start = Math.floor(new Date(`${firstDate}T${timeOfDay}Z`).getTime() / 1000);
    const points = (await fetchChartPrices(["bitcoin"], start, daysBack + 1)).get("bitcoin") ?? [];
    return new Map(points.map((p) => [p.date, p.priceUsd]));
  };

  const midnight = await chartFrom("00:00:00");
  const backfillGridByRun = new Map<string, Map<string, number>>();
  if (backfillRunIds.size > 0) {
    const { data, error } = await db.from("screener_runs").select("id, started_at").in("id", [...backfillRunIds]);
    if (error) throw new Error(`Failed to read backfill runs for BTC grids: ${error.message}`);
    for (const run of data ?? []) {
      backfillGridByRun.set(run.id as string, await chartFrom((run.started_at as string).slice(11, 19)));
    }
  }

  const byRun = new Map<string, number>();
  let backfilledRuns = 0;
  const runIds = [...liveRuns.keys()];
  if (runIds.length > 0) {
    const { data, error } = await db.from("screener_runs").select("id, notes").in("id", runIds);
    if (error) throw new Error(`Failed to read run notes for BTC reference: ${error.message}`);
    for (const run of data ?? []) {
      const notes = (run.notes ?? {}) as { reference_prices?: { bitcoin?: { price_usd?: number } } };
      const stored = notes.reference_prices?.bitcoin?.price_usd;
      if (typeof stored === "number") {
        byRun.set(run.id as string, stored);
        continue;
      }
      const observedAt = liveRuns.get(run.id as string)!;
      const price = (await fetchPricesAt(["bitcoin"], Math.floor(new Date(observedAt).getTime() / 1000))).get("bitcoin");
      if (price === undefined) continue; // stays unpaired -> that reading yields null, never a different-moment fallback
      byRun.set(run.id as string, price);
      backfilledRuns++;
      await db
        .from("screener_runs")
        .update({
          notes: {
            ...(run.notes as Record<string, unknown>),
            reference_prices: { bitcoin: { price_usd: price, source: `defillama /prices/historical at observed_at ${observedAt} (run predates same-response BTC)` } },
          },
        })
        .eq("id", run.id as string);
    }
  }
  return { btc: { backfillGridByRun, midnight, byRun }, ms: Date.now() - t0, backfilledRuns, grids: backfillGridByRun.size + 1 };
}

/** Metrics + gates for every asset in one live run, including the Phase 2b
 * history-derived fields (as of the run's own observed_at — never later
 * data). Idempotent: re-running overwrites (upsert on (run_id, asset_id)). */
export async function computeRunMetrics(
  runId: string,
  configVersionId: string,
): Promise<{
  assets: number;
  rated: number;
  timing_ms: Record<string, number>;
  history_rows: number;
  btc_runs_backfilled: number;
  btc_grids: number;
  plausibility_warnings: PlausibilityWarning[];
}> {
  const db = serviceDb();
  // A live run has ~700 rows; one page is enough, but page defensively.
  const rows: (SnapshotForMetrics & { observed_at: string; screener_assets: { gecko_id: string; sector: string | null } })[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("screener_asset_snapshots")
      .select(
        "asset_id, observed_at, price_usd, market_cap_usd, fdv_usd, circulating_supply, total_supply, max_supply, tvl_usd, fees_30d, revenue_30d, holders_revenue_30d, volume_24h_usd, screener_assets(gecko_id, sector)",
      )
      .eq("run_id", runId)
      .eq("is_backfilled", false)
      .order("asset_id")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to read snapshots for run ${runId}: ${error.message}`);
    rows.push(...((data ?? []) as unknown as typeof rows));
    if (!data || data.length < 1000) break;
  }
  if (rows.length === 0) throw new Error(`Run ${runId} has no live snapshot rows`);
  const asOf = rows.reduce((max, r) => (r.observed_at > max ? r.observed_at : max), rows[0].observed_at);

  const history = await loadHistoryReadings(asOf);
  const byAsset = new Map<string, HistoryRow[]>();
  const liveRuns = new Map<string, string>(); // run_id -> observed_at
  const backfillRunIds = new Set<string>();
  for (const h of history.rows) {
    if (!byAsset.has(h.asset_id)) byAsset.set(h.asset_id, []);
    byAsset.get(h.asset_id)!.push(h);
    if (h.is_backfilled) backfillRunIds.add(h.run_id);
    else liveRuns.set(h.run_id, h.observed_at);
  }
  const reference = await loadBtcReference(asOf, liveRuns, backfillRunIds);

  const t0 = Date.now();
  const metrics = rows.map((r) =>
    computeAssetMetrics(
      { ...r, gecko_id: r.screener_assets.gecko_id, sector: r.screener_assets.sector },
      SCREENER_CONFIG,
      computeHistoryMetrics(byAsset.get(r.asset_id) ?? [], asOf, reference.btc, SCREENER_CONFIG.history),
    ),
  );
  const computeMs = Date.now() - t0;
  // Implausible run-level results are reported (run notes + log), never
  // silently written as if fine — see plausibility.ts for why.
  const plausibilityWarnings = checkPlausibility(metrics);
  if (plausibilityWarnings.length > 0) {
    console.warn(`[screener] run ${runId} plausibility warnings: ${JSON.stringify(plausibilityWarnings)}`);
  }

  const t1 = Date.now();
  const computedAt = new Date().toISOString();
  for (let i = 0; i < metrics.length; i += WRITE_CHUNK) {
    const { error } = await db.from("screener_asset_metrics").upsert(
      metrics.slice(i, i + WRITE_CHUNK).map((m) => ({ ...m, run_id: runId, config_version_id: configVersionId, computed_at: computedAt })),
      { onConflict: "run_id,asset_id" },
    );
    if (error) throw new Error(`Failed to write screener_asset_metrics: ${error.message}`);
  }
  return {
    assets: metrics.length,
    rated: metrics.filter((m) => m.rated).length,
    history_rows: history.rows.length,
    btc_runs_backfilled: reference.backfilledRuns,
    btc_grids: reference.grids,
    plausibility_warnings: plausibilityWarnings,
    timing_ms: { history_read: history.ms, btc_reference: reference.ms, compute: computeMs, write: Date.now() - t1 },
  };
}

const SOURCE_RETRY_DELAY_MS = 5000;

/** Runs `fn` (one retry after a pause), recording its source; a failed
 * source leaves its inputs null (and the rules that need them not
 * evaluable) instead of failing the regime. The retry covers errors
 * fetchWithRetry doesn't (it only retries 429/503): the first Phase 2a run
 * lost BTC dominance to a one-off HTTP 400 from CoinGecko /global that
 * didn't reproduce — and each missed day is a hole in the 28-day history
 * the dominance/OI changes are built from. */
async function source<T>(
  provenance: Record<string, unknown>,
  name: string,
  endpoint: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await fn();
      provenance[name] = { endpoint, fetched_at: new Date().toISOString(), ...(attempt > 1 ? { attempts: attempt } : {}) };
      return value;
    } catch (e) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, SOURCE_RETRY_DELAY_MS));
        continue;
      }
      provenance[name] = { endpoint, error: (e as Error).message, attempts: attempt };
      return null;
    }
  }
}

const pctChange = (now: number | null | undefined, then: number | null | undefined): number | null =>
  now == null || then == null || !(then > 0) ? null : (now / then - 1) * 100;

/** Market regime for one live run: fetch today's inputs, derive 4-week
 * changes from our own stored history where no free history exists
 * (dominance, open interest), label with three-valued rules. */
export async function computeRegime(runId: string, configVersionId: string): Promise<{ label: string; evaluable: number }> {
  const db = serviceDb();
  const cfg = SCREENER_CONFIG.regime;
  const provenance: Record<string, unknown> = {};
  const lookbackEpoch = Math.floor((Date.now() - cfg.lookbackDays * DAY_MS) / 1000);

  const btcDominancePct = await source(provenance, "btc_dominance", "coingecko /global", fetchBtcDominancePct);
  // Chosen source: the dated daily chart (see fetchStablecoinDailyChange).
  // The snapshot endpoint's circulatingPrevMonth figure is stored alongside
  // (…_prevmonth) only to see when the two would disagree, until the 30d
  // change switches to our own stored history (BACKLOG, ~2026-10-22).
  const stableChange = await source(provenance, "stablecoin_daily_chart", "stablecoins.llama.fi /stablecoincharts/all", () =>
    fetchStablecoinDailyChange(30),
  );
  const stables = await source(provenance, "stablecoin_snapshot", "stablecoins.llama.fi /stablecoins", fetchStablecoinSupply);
  const pricesNow = await source(provenance, "prices_now", "coins.llama.fi /prices/current", () =>
    fetchPricesAt(["bitcoin", "ethereum"]),
  );
  const pricesThen = await source(provenance, "prices_4w_ago", `coins.llama.fi /prices/historical/${lookbackEpoch}`, () =>
    fetchPricesAt(["bitcoin", "ethereum"], lookbackEpoch),
  );
  const perps = await source(provenance, "perps", "api.hyperliquid.xyz /info metaAndAssetCtxs", () =>
    fetchPerpContexts(["BTC", "ETH"]),
  );

  // Our own history: the stored regime row nearest to 4 weeks ago (within
  // tolerance), and every prior day's funding for the percentile.
  const target = Date.now() - cfg.lookbackDays * DAY_MS;
  const tol = cfg.lookbackToleranceDays * DAY_MS;
  const { data: history, error: historyError } = await db
    .from("screener_regime_snapshots")
    .select("run_id, computed_at, btc_dominance_pct, btc_open_interest_usd, avg_funding_rate_hourly")
    .neq("run_id", runId)
    .order("computed_at", { ascending: true });
  if (historyError) throw new Error(`Failed to read regime history: ${historyError.message}`);
  const near = (history ?? [])
    .filter((h) => Math.abs(new Date(h.computed_at as string).getTime() - target) <= tol)
    .sort((a, b) => Math.abs(new Date(a.computed_at as string).getTime() - target) - Math.abs(new Date(b.computed_at as string).getTime() - target))[0];

  const btc = perps?.get("BTC");
  const eth = perps?.get("ETH");
  const avgFunding = btc && eth ? (btc.funding + eth.funding) / 2 : null;
  const fundingHistory = oneValuePerDay(
    (history ?? []).map((h) => ({ computed_at: h.computed_at as string, value: h.avg_funding_rate_hourly as number | null })),
  );

  const btcNow = pricesNow?.get("bitcoin");
  const ethNow = pricesNow?.get("ethereum");
  const btcThen = pricesThen?.get("bitcoin");
  const ethThen = pricesThen?.get("ethereum");

  const inputs: RegimeInputs = {
    btcDominancePct,
    btcDominance4wChangePts:
      btcDominancePct !== null && near?.btc_dominance_pct != null ? btcDominancePct - (near.btc_dominance_pct as number) : null,
    ethBtc4wChangePct: btcNow && ethNow && btcThen && ethThen ? pctChange(ethNow / btcNow, ethThen / btcThen) : null,
    stablecoinSupply30dChangePct: stableChange ? pctChange(stableChange.latestUsd, stableChange.priorUsd) : null,
    fundingPercentile: percentileOf(avgFunding, fundingHistory, cfg.fundingHistoryMinDays),
    btcOi4wChangePct: pctChange(btc?.openInterestUsd, near?.btc_open_interest_usd as number | null | undefined),
    btcPrice4wChangePct: pctChange(btcNow, btcThen),
  };
  const { label, rules } = evaluateRegime(inputs);
  provenance.history = {
    lookback_row_computed_at: near?.computed_at ?? null,
    funding_history_points: fundingHistory.length,
    stablecoin_assets_counted: stables?.assetsCounted ?? null,
    stablecoin_change_dates: stableChange ? [stableChange.priorDate, stableChange.latestDate] : null,
  };

  const { error } = await db.from("screener_regime_snapshots").upsert(
    {
      run_id: runId,
      config_version_id: configVersionId,
      computed_at: new Date().toISOString(),
      label,
      btc_dominance_pct: inputs.btcDominancePct,
      btc_dominance_4w_change_pts: inputs.btcDominance4wChangePts,
      eth_btc_4w_change_pct: inputs.ethBtc4wChangePct,
      stablecoin_supply_usd: stableChange?.latestUsd ?? null,
      stablecoin_supply_30d_change_pct: inputs.stablecoinSupply30dChangePct,
      stablecoin_supply_30d_change_pct_prevmonth: stables ? pctChange(stables.totalUsd, stables.prevMonthUsd) : null,
      avg_funding_rate_hourly: avgFunding,
      funding_percentile_1y: inputs.fundingPercentile,
      btc_open_interest_usd: btc?.openInterestUsd ?? null,
      btc_oi_4w_change_pct: inputs.btcOi4wChangePct,
      btc_price_4w_change_pct: inputs.btcPrice4wChangePct,
      rules,
      provenance,
    },
    { onConflict: "run_id" },
  );
  if (error) throw new Error(`Failed to write screener_regime_snapshots: ${error.message}`);
  return { label, evaluable: rules.filter((r) => r.fired !== null).length };
}

/** Phase 3: tier, Score B, grades and setup tags for one run's rated
 * assets, from its already-written metrics (so it can also re-score an
 * existing run). Replaces the run's previous scores wholesale — a config
 * change can change which assets are rated, and an upsert would leave a
 * no-longer-rated asset's old row behind. */
export async function computeRunScores(
  runId: string,
  configVersionId: string,
  regimeLabel: RegimeLabel | null,
): Promise<Omit<RunScores, "scores"> & { write_ms: number }> {
  const db = serviceDb();
  const { data: metrics, error: metricsError } = await db
    .from("screener_asset_metrics")
    .select("asset_id, mom_3w, mom_12w, beta_btc, rev_90d_change, dilution_rate")
    .eq("run_id", runId)
    .eq("rated", true);
  if (metricsError) throw new Error(`Failed to read metrics for run ${runId}: ${metricsError.message}`);
  const ids = (metrics ?? []).map((m) => m.asset_id as string);

  const mcap = new Map<string, number | null>();
  const conflicted = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const [snaps, conflicts] = await Promise.all([
      db.from("screener_asset_snapshots").select("asset_id, market_cap_usd").eq("run_id", runId).eq("is_backfilled", false).in("asset_id", batch),
      db.from("screener_field_conflicts").select("asset_id").eq("run_id", runId).in("field_name", ["price_usd", "market_cap_usd"]).in("asset_id", batch),
    ]);
    if (snaps.error) throw new Error(`Failed to read snapshots for scoring: ${snaps.error.message}`);
    if (conflicts.error) throw new Error(`Failed to read conflicts for scoring: ${conflicts.error.message}`);
    for (const r of snaps.data ?? []) mcap.set(r.asset_id as string, r.market_cap_usd as number | null);
    for (const r of conflicts.data ?? []) conflicted.add(r.asset_id as string);
  }

  const inputs: ScoreInput[] = (metrics ?? []).map((m) => ({
    asset_id: m.asset_id as string,
    mom_3w: m.mom_3w as number | null,
    mom_12w: m.mom_12w as number | null,
    beta_btc: m.beta_btc as number | null,
    rev_90d_change: m.rev_90d_change as number | null,
    dilution_rate: m.dilution_rate as number | null,
    unlocks_90d_pct_circulating: null, // no unlock source yet (screener_manual_unlocks deferred)
    market_cap_usd: mcap.get(m.asset_id as string) ?? null,
    has_source_conflict: conflicted.has(m.asset_id as string),
  }));
  const { scores, ...summary } = scoreRun(inputs, regimeLabel);
  if (summary.warnings.length > 0) console.warn(`[screener] run ${runId} scoring warnings: ${JSON.stringify(summary.warnings)}`);

  const t0 = Date.now();
  const { error: deleteError } = await db.from("screener_asset_scores").delete().eq("run_id", runId);
  if (deleteError) throw new Error(`Failed to clear previous scores for run ${runId}: ${deleteError.message}`);
  const computedAt = new Date().toISOString();
  for (let i = 0; i < scores.length; i += WRITE_CHUNK) {
    const { error } = await db
      .from("screener_asset_scores")
      .insert(scores.slice(i, i + WRITE_CHUNK).map((s) => ({ ...s, run_id: runId, config_version_id: configVersionId, computed_at: computedAt })));
    if (error) throw new Error(`Failed to write screener_asset_scores: ${error.message}`);
  }
  return { ...summary, write_ms: Date.now() - t0 };
}

/** Every derivation step for a finished live run, each isolated; the outcome
 * of each is merged into the run's own notes (success or error). */
export async function runScreenerDerivations(runId: string): Promise<Record<string, unknown>> {
  const outcome: Record<string, unknown> = {};
  let configVersionId: string | null = null;
  try {
    configVersionId = await ensureConfigVersion();
    outcome.config_version_id = configVersionId;
  } catch (e) {
    outcome.config_error = (e as Error).message;
  }
  if (configVersionId) {
    try {
      outcome.metrics = await computeRunMetrics(runId, configVersionId);
    } catch (e) {
      outcome.metrics_error = (e as Error).message;
    }
    let regimeLabel: RegimeLabel | null = null;
    try {
      const regime = await computeRegime(runId, configVersionId);
      outcome.regime = regime;
      regimeLabel = regime.label as RegimeLabel;
    } catch (e) {
      outcome.regime_error = (e as Error).message;
    }
    // Scores read this run's metrics — without them there's nothing (or
    // only a stale set) to score. A failed regime just means no modifier.
    if (outcome.metrics) {
      try {
        outcome.scores = await computeRunScores(runId, configVersionId, regimeLabel);
      } catch (e) {
        outcome.scores_error = (e as Error).message;
      }
    } else {
      outcome.scores_error = "skipped: metrics step failed";
    }
  }

  const db = serviceDb();
  const { data: run } = await db.from("screener_runs").select("notes").eq("id", runId).single();
  await db
    .from("screener_runs")
    .update({ notes: { ...((run?.notes as Record<string, unknown>) ?? {}), derivations: outcome } })
    .eq("id", runId);
  return outcome;
}

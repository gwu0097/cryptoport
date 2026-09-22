import "server-only";
import { serviceDb } from "@/lib/supabase";
import { SCREENER_CONFIG, configHash, validateConfig } from "./config";
import { computeAssetMetrics, type SnapshotForMetrics } from "./metrics";
import { evaluateRegime, percentileOf, type RegimeInputs } from "./regime";
import { fetchBtcDominancePct } from "./adapters/coingecko";
import { fetchStablecoinSupply } from "./adapters/defillama";
import { fetchPricesAt } from "./adapters/defillamaPrices";
import { fetchPerpContexts } from "./adapters/hyperliquid";

// Phase 2a: everything derived from a finished live snapshot run — per-asset
// metrics + kill-filter gates, and the market regime — stamped with the
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

/** Metrics + gates for every asset in one live run. Idempotent: re-running
 * for the same run overwrites (upsert on the (run_id, asset_id) key). */
export async function computeRunMetrics(runId: string, configVersionId: string): Promise<{ assets: number; rated: number }> {
  const db = serviceDb();
  // A live run has ~700 rows; one page is enough, but page defensively.
  const rows: (SnapshotForMetrics & { screener_assets: { gecko_id: string; sector: string | null } })[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("screener_asset_snapshots")
      .select(
        "asset_id, price_usd, market_cap_usd, fdv_usd, circulating_supply, total_supply, max_supply, tvl_usd, fees_30d, revenue_30d, holders_revenue_30d, volume_24h_usd, screener_assets(gecko_id, sector)",
      )
      .eq("run_id", runId)
      .eq("is_backfilled", false)
      .order("asset_id")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to read snapshots for run ${runId}: ${error.message}`);
    rows.push(...((data ?? []) as unknown as typeof rows));
    if (!data || data.length < 1000) break;
  }

  const metrics = rows.map((r) =>
    computeAssetMetrics({ ...r, gecko_id: r.screener_assets.gecko_id, sector: r.screener_assets.sector }),
  );
  const computedAt = new Date().toISOString();
  for (let i = 0; i < metrics.length; i += WRITE_CHUNK) {
    const { error } = await db.from("screener_asset_metrics").upsert(
      metrics.slice(i, i + WRITE_CHUNK).map((m) => ({ ...m, run_id: runId, config_version_id: configVersionId, computed_at: computedAt })),
      { onConflict: "run_id,asset_id" },
    );
    if (error) throw new Error(`Failed to write screener_asset_metrics: ${error.message}`);
  }
  return { assets: metrics.length, rated: metrics.filter((m) => m.rated).length };
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
  const stables = await source(provenance, "stablecoin_supply", "stablecoins.llama.fi /stablecoins", fetchStablecoinSupply);
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
  const fundingHistory = (history ?? [])
    .map((h) => h.avg_funding_rate_hourly as number | null)
    .filter((v): v is number => v !== null);

  const btcNow = pricesNow?.get("bitcoin");
  const ethNow = pricesNow?.get("ethereum");
  const btcThen = pricesThen?.get("bitcoin");
  const ethThen = pricesThen?.get("ethereum");

  const inputs: RegimeInputs = {
    btcDominancePct,
    btcDominance4wChangePts:
      btcDominancePct !== null && near?.btc_dominance_pct != null ? btcDominancePct - (near.btc_dominance_pct as number) : null,
    ethBtc4wChangePct: btcNow && ethNow && btcThen && ethThen ? pctChange(ethNow / btcNow, ethThen / btcThen) : null,
    stablecoinSupply30dChangePct: stables ? pctChange(stables.totalUsd, stables.prevMonthUsd) : null,
    fundingPercentile: percentileOf(avgFunding, fundingHistory, cfg.fundingHistoryMinDays),
    btcOi4wChangePct: pctChange(btc?.openInterestUsd, near?.btc_open_interest_usd as number | null | undefined),
    btcPrice4wChangePct: pctChange(btcNow, btcThen),
  };
  const { label, rules } = evaluateRegime(inputs);
  provenance.history = {
    lookback_row_computed_at: near?.computed_at ?? null,
    funding_history_points: fundingHistory.length,
    stablecoin_assets_counted: stables?.assetsCounted ?? null,
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
      stablecoin_supply_usd: stables?.totalUsd ?? null,
      stablecoin_supply_30d_change_pct: inputs.stablecoinSupply30dChangePct,
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

/** Both Phase 2a steps for a finished live run, each isolated; the outcome
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
    try {
      outcome.regime = await computeRegime(runId, configVersionId);
    } catch (e) {
      outcome.regime_error = (e as Error).message;
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

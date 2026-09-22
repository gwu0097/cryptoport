import "server-only";
import { serviceDb } from "@/lib/supabase";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { fetchProtocolFeeHistory, type FeesDataType } from "./adapters/defillama";
import { fetchHistoricalMarketData } from "./adapters/coingecko";
import { fetchChartPrices, type ChartPricePoint } from "./adapters/defillamaPrices";
import { sumDailySeriesAcrossSlugs, rollingSum, type DailyPoint } from "./aggregate";
import { buildBackfillRunProvenance, BACKFILL_PRICE_FALLBACK_OVERRIDE } from "./provenance";
import { fetchAllRows } from "./pagination";

// Days of history the backfill writes into Supabase — and the CoinGecko
// free-tier ceiling (365 works, 366 doesn't, live-verified in
// DATA_SOURCES.md; never raise without re-verifying). Same number on
// purpose: the agreed retention plan keeps at most ~365 days of backfill
// in Supabase (the 0.5 GB free tier can't hold more — see BACKLOG.md's
// storage entry); deeper DefiLlama price history is for local Parquet,
// not this table. Fee history is still fetched in full so the rolling
// 30d sums at the start of the window are complete.
const BACKFILL_DAYS = 365;

// Assets processed concurrently. Each asset itself makes
// (contributing slugs × 3) DefiLlama fee-history calls, capped separately
// by SLUG_CALL_CONCURRENCY, plus one CoinGecko market_chart call.
const CONCURRENCY = 4;
const SLUG_CALL_CONCURRENCY = 3;

// Coins per /chart call. DefiLlama's 500-point cap is coins × days per
// call, so batching doesn't reduce the total number of calls much —
// fetchChartPrices shrinks the span to fit (15 coins → 33 days per call,
// ~12 calls per batch for 366 days). The throttle (serial, 1.5s before
// every HTTP call) lives in fetchChartPrices itself.
const PRICE_BATCH_SIZE = 15;

const INSERT_CHUNK_SIZE = 500; // single-statement inserts of long histories hit a statement timeout (Phase 1)

const DATA_TYPES: FeesDataType[] = ["dailyFees", "dailyRevenue", "dailyHoldersRevenue"];

export interface BackfillOptions {
  /** Restrict to these gecko_ids (the 20-asset validation run). Omit for
   * the whole universe. */
  geckoIds?: string[];
}

export interface BackfillAssetResult {
  geckoId: string;
  rowsInserted: number;
  rowsSkippedExisting: number;
  error: string | null;
}

export interface BackfillResult {
  runId: string;
  assetsProcessed: number;
  totalRowsInserted: number;
  perAsset: BackfillAssetResult[];
}

interface MergedDay {
  date: string;
  price_usd: number | null;
  priceSource: "defillama" | "coingecko" | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  fees_24h: number | null;
  fees_30d: number | null;
  revenue_24h: number | null;
  revenue_30d: number | null;
  holders_revenue_24h: number | null;
  holders_revenue_30d: number | null;
}

/** Serial, batched DefiLlama price pre-fetch for the whole asset list —
 * one /chart call covers up to PRICE_BATCH_SIZE coins. Throttling is owned
 * entirely by fetchChartPrices (see its own doc comment for why). */
async function fetchWindowPrices(geckoIds: string[], startEpoch: number): Promise<Map<string, ChartPricePoint[]>> {
  const result = new Map<string, ChartPricePoint[]>();
  for (let i = 0; i < geckoIds.length; i += PRICE_BATCH_SIZE) {
    const batch = geckoIds.slice(i, i + PRICE_BATCH_SIZE);
    console.log(`  price batch ${Math.floor(i / PRICE_BATCH_SIZE) + 1}/${Math.ceil(geckoIds.length / PRICE_BATCH_SIZE)}...`);
    const batchResult = await fetchChartPrices(batch, startEpoch, BACKFILL_DAYS + 1);
    for (const [id, points] of batchResult) result.set(id, points);
  }
  return result;
}

/** Each asset's contributing slugs, taken from the latest successful LIVE
 * run's own rows — the backfill reuses the live job's exact group
 * membership rather than re-deriving it (the old single-slug divergence
 * is what produced wrong backfilled fees/revenue, see aggregate.ts). */
async function loadLiveMembership(): Promise<Map<string, string[]>> {
  const db = serviceDb();
  const { data: run, error } = await db
    .from("screener_runs")
    .select("id")
    .eq("kind", "live")
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load latest live run: ${error.message}`);
  if (!run) throw new Error("No successful live snapshot run yet — run /api/cron/screener-snapshot first");

  const rows = await fetchAllRows<{ id: string; asset_id: string; contributing_slugs: string[] | null }>(async (cursor, limit) =>
    db
      .from("screener_asset_snapshots")
      .select("id, asset_id, contributing_slugs")
      .eq("run_id", run.id as string)
      .gt("id", cursor)
      .order("id")
      .limit(limit),
  );
  const membership = new Map<string, string[]>();
  for (const r of rows) if (r.contributing_slugs && r.contributing_slugs.length > 0) membership.set(r.asset_id, r.contributing_slugs);
  return membership;
}

/**
 * Historical backfill — run manually (`scripts/screener-backfill.ts`), not
 * on a schedule. Every row gets `is_backfilled = true` and the `run_id` of
 * its own `kind = 'backfill'` screener_runs row (which carries the
 * provenance manifest). Idempotent: an (asset, date) pair that already has
 * a backfilled row is skipped, never updated (per-row update-in-place was
 * tried in Phase 1 and was thousands of sequential round trips) — also
 * enforced by the partial unique index on (asset_id, UTC date).
 */
export async function runScreenerBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const db = serviceDb();
  const startedAt = new Date().toISOString();

  const { data: runRow, error: runError } = await db
    .from("screener_runs")
    .insert({
      started_at: startedAt,
      kind: "backfill",
      status: "running",
      provenance: buildBackfillRunProvenance(startedAt),
      notes: { window_days: BACKFILL_DAYS, gecko_ids: options.geckoIds ?? "all" },
    })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to start backfill screener_runs: ${runError.message}`);
  const runId = runRow.id as string;

  try {
    let assetRows = await fetchAllRows<{ id: string; gecko_id: string }>(async (cursor, limit) =>
      db.from("screener_assets").select("id, gecko_id").gt("id", cursor).order("id").limit(limit),
    );
    if (options.geckoIds) {
      const wanted = new Set(options.geckoIds);
      assetRows = assetRows.filter((a) => wanted.has(a.gecko_id));
      const missing = options.geckoIds.filter((id) => !assetRows.some((a) => a.gecko_id === id));
      if (missing.length > 0) throw new Error(`Not in screener_assets: ${missing.join(", ")}`);
    }

    const membership = await loadLiveMembership();
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() - BACKFILL_DAYS);
    const windowStartDate = windowStart.toISOString().slice(0, 10);
    const todayDate = new Date().toISOString().slice(0, 10);
    const windowStartEpoch = Math.floor(windowStart.getTime() / 1000);

    const windowPrices = await fetchWindowPrices(
      assetRows.map((a) => a.gecko_id),
      windowStartEpoch,
    );

    const perAsset = await mapWithConcurrency(assetRows, CONCURRENCY, async (asset): Promise<BackfillAssetResult> => {
      try {
        const slugs = membership.get(asset.id);
        if (!slugs) throw new Error("No contributing_slugs in the latest live run (asset unmatched today?)");

        const slugCalls = slugs.flatMap((slug) => DATA_TYPES.map((dataType) => ({ slug, dataType })));
        const [histories, marketHistory, existing] = await Promise.all([
          mapWithConcurrency(slugCalls, SLUG_CALL_CONCURRENCY, async (c) => ({
            ...c,
            points: await fetchProtocolFeeHistory(c.slug, c.dataType),
          })),
          fetchHistoricalMarketData(asset.gecko_id, BACKFILL_DAYS),
          fetchAllRows<{ id: string; observed_at: string }>(async (cursor, limit) =>
            db
              .from("screener_asset_snapshots")
              .select("id, observed_at")
              .eq("asset_id", asset.id)
              .eq("is_backfilled", true)
              .gt("id", cursor)
              .order("id")
              .limit(limit),
          ),
        ]);
        const existingDates = new Set(existing.map((r) => r.observed_at.slice(0, 10)));

        const seriesFor = (dataType: FeesDataType): DailyPoint[] =>
          sumDailySeriesAcrossSlugs(
            slugs,
            new Map(histories.filter((h) => h.dataType === dataType).map((h) => [h.slug, h.points])),
          );
        const fees = seriesFor("dailyFees");
        const revenue = seriesFor("dailyRevenue");
        const holdersRevenue = seriesFor("dailyHoldersRevenue");

        const byDate = new Map<string, MergedDay>();
        const ensure = (date: string): MergedDay => {
          let row = byDate.get(date);
          if (!row) {
            row = {
              date,
              price_usd: null,
              priceSource: null,
              market_cap_usd: null,
              volume_24h_usd: null,
              fees_24h: null,
              fees_30d: null,
              revenue_24h: null,
              revenue_30d: null,
              holders_revenue_24h: null,
              holders_revenue_30d: null,
            };
            byDate.set(date, row);
          }
          return row;
        };
        // CoinGecko first (price fallback + the only mcap/volume source),
        // DefiLlama second so its price — the approved primary — wins for
        // any date both cover.
        for (const p of marketHistory) {
          const row = ensure(p.date);
          row.price_usd = p.priceUsd;
          row.priceSource = "coingecko";
          row.market_cap_usd = p.marketCapUsd;
          row.volume_24h_usd = p.volume24hUsd;
        }
        for (const p of windowPrices.get(asset.gecko_id) ?? []) {
          const row = ensure(p.date);
          row.price_usd = p.priceUsd;
          row.priceSource = "defillama";
        }
        for (const p of fees) ensure(p.date).fees_24h = p.value;
        for (const [date, v] of rollingSum(fees, 30)) ensure(date).fees_30d = v;
        for (const p of revenue) ensure(p.date).revenue_24h = p.value;
        for (const [date, v] of rollingSum(revenue, 30)) ensure(date).revenue_30d = v;
        for (const p of holdersRevenue) ensure(p.date).holders_revenue_24h = p.value;
        for (const [date, v] of rollingSum(holdersRevenue, 30)) ensure(date).holders_revenue_30d = v;

        // Today (UTC) is excluded: every source's current day is incomplete —
        // live-verified on the first validation run: today's row had an
        // intraday price, null mcap for 19/20 assets and null fees for 9/20.
        // A partial day stored as a full backfilled day could never be
        // corrected later (the backfill skips dates that already have a row).
        const inWindow = [...byDate.values()].filter((r) => r.date >= windowStartDate && r.date < todayDate);
        const toInsert = inWindow
          .filter((r) => !existingDates.has(r.date))
          .map((r) => ({
            asset_id: asset.id,
            observed_at: `${r.date}T12:00:00.000Z`, // noon UTC — this row represents the whole day
            run_id: runId,
            is_backfilled: true,
            price_usd: r.price_usd,
            market_cap_usd: r.market_cap_usd,
            volume_24h_usd: r.volume_24h_usd,
            fees_24h: r.fees_24h,
            fees_30d: r.fees_30d,
            revenue_24h: r.revenue_24h,
            revenue_30d: r.revenue_30d,
            holders_revenue_24h: r.holders_revenue_24h,
            holders_revenue_30d: r.holders_revenue_30d,
            contributing_slugs: slugs,
            provenance_override: r.priceSource === "coingecko" ? BACKFILL_PRICE_FALLBACK_OVERRIDE : null,
          }));

        for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
          const { error: insertError } = await db.from("screener_asset_snapshots").insert(toInsert.slice(i, i + INSERT_CHUNK_SIZE));
          if (insertError) throw new Error(insertError.message);
        }

        return {
          geckoId: asset.gecko_id,
          rowsInserted: toInsert.length,
          rowsSkippedExisting: inWindow.length - toInsert.length,
          error: null,
        };
      } catch (e) {
        // One asset's failure never stops the rest.
        return { geckoId: asset.gecko_id, rowsInserted: 0, rowsSkippedExisting: 0, error: (e as Error).message };
      }
    });

    const failed = perAsset.filter((r) => r.error !== null).length;
    const totalRowsInserted = perAsset.reduce((sum, r) => sum + r.rowsInserted, 0);
    await db
      .from("screener_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: failed === 0 ? "ok" : failed === perAsset.length ? "error" : "partial",
        universe_size: assetRows.length,
        matched_count: perAsset.length - failed,
        unmatched_count: failed,
        notes: { window_days: BACKFILL_DAYS, gecko_ids: options.geckoIds ?? "all", rows_inserted: totalRowsInserted },
      })
      .eq("id", runId);

    return { runId, assetsProcessed: assetRows.length, totalRowsInserted, perAsset };
  } catch (e) {
    await db
      .from("screener_runs")
      .update({ finished_at: new Date().toISOString(), status: "error", notes: { error: (e as Error).message } })
      .eq("id", runId);
    throw e;
  }
}

import "server-only";
import { serviceDb } from "@/lib/supabase";
import { fetchAllRows } from "./pagination";

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

  const { data: runRow, error: runError } = await db
    .from("screener_runs")
    .select("id, started_at, unmatched_count, notes")
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError) throw new Error(`Failed to load latest screener_runs: ${runError.message}`);
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

import "server-only";
import { serviceDb } from "@/lib/supabase";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { fetchProtocolFeeHistory, type FeesDataType, type ProtocolFeeHistoryPoint } from "./adapters/defillama";
import { fetchHistoricalMarketData } from "./adapters/coingecko";
import { fetchChartPrices, type ChartPricePoint } from "./adapters/defillamaPrices";
import { fetchAllRows } from "./pagination";

// Same free-tier boundary live-verified in DATA_SOURCES.md — 365 works,
// 366 doesn't. Never raise this without re-verifying the ceiling hasn't
// moved. CoinGecko remains the ONLY source for historical market cap and
// volume (DefiLlama's /chart, below, only ever returns price — live-
// verified, not an oversight) — so this window is still fetched, it's
// just no longer the primary price source. See fetchChartPrices' own doc
// comment for the approved split: DefiLlama price (deep), CoinGecko
// mcap/volume (365d) + price fallback for any date DefiLlama lacks.
const COINGECKO_MAX_DAYS = 365;

// Real external-API fan-out (up to 4 calls per asset: 3 DefiLlama fee-
// history + 1 CoinGecko market_chart) — capped the same way every other
// multi-call adapter loop in this app is. The DefiLlama *price* fetch
// (below) is a separate, serial, pre-batched phase — not part of this
// concurrent per-asset loop at all.
const CONCURRENCY = 4;

// How far back to request DefiLlama's price series, uniformly for every
// asset — DefiLlama simply returns fewer points for a younger asset, no
// error, so one fixed generous window works for the whole universe rather
// than needing to know each asset's own history depth in advance.
const DEEP_PRICE_DAYS = 1825; // 5 years

// Coins per /chart call — the actual throttle (serial, 1.5s between every
// individual HTTP call, the validated safe rate from PHASE_1 sign-off
// item 5/C) lives in fetchChartPrices itself now, not here. Batch size of
// 15 keeps URL length well clear of any practical limit even with longer
// gecko_ids, not independently pushed higher.
const PRICE_BATCH_SIZE = 15;

export interface BackfillAssetResult {
  geckoId: string;
  rowsInserted: number;
  rowsSkippedExisting: number;
  error: string | null;
}

export interface BackfillResult {
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

/**
 * DefiLlama's per-protocol history endpoint (dataType=dailyX) reports one
 * DAILY value per day, not a rolling window — live-verified against Aave:
 * summing its trailing 30 daily chart points ($5,110,658) landed within
 * ~0.5% of the current live total30d figure ($5,086,396), confirming each
 * point is a single day's value. The live snapshot job's `fees_30d`/
 * `revenue_30d`/`holders_revenue_30d` columns store DefiLlama's own
 * *rolling* total30d — so backfilled rows need the same rolling sum
 * computed here, not the raw daily figure copied straight in. Copying the
 * daily value into a `_30d`-named column would have been silently off by
 * roughly 30x, exactly the kind of unit mismatch this app's Data
 * Correctness rule exists to catch before it ships, not after.
 *
 * `_24h` for a historical day is just that day's own raw value (no
 * summing needed — DefiLlama's live total24h is already "the last 24h,"
 * and a historical day's "last 24h as of that day" is that day's own
 * figure). `_7d`/`_1y` are deliberately left null for backfilled rows —
 * not computed in this pass, scoped out rather than guessed at; Phase 4's
 * stated needs (30/90-day forward-return tests) don't need them yet.
 */
function rollingSum(series: ProtocolFeeHistoryPoint[], windowDays: number): Map<string, number> {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const result = new Map<string, number>();
  let windowStart = 0;
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i].value;
    const cutoff = new Date(sorted[i].date);
    cutoff.setUTCDate(cutoff.getUTCDate() - windowDays + 1);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    while (windowStart < i && sorted[windowStart].date < cutoffStr) {
      sum -= sorted[windowStart].value;
      windowStart++;
    }
    result.set(sorted[i].date, sum);
  }
  return result;
}

/** Serial, batched DefiLlama price pre-fetch for the whole universe — a
 * separate phase from the concurrent per-asset loop below, since batching
 * only pays off across many assets at once (one /chart call covers up to
 * PRICE_BATCH_SIZE coins). Chained internally per batch for depth beyond
 * the 500-point/call ceiling. Throttling is owned entirely by
 * fetchChartPrices itself (sleeps before every individual HTTP call it
 * makes, including the first) — not duplicated here, after an earlier
 * version's split responsibility (sleep here between batches, none
 * between a batch's own chained calls) let up to 4 requests fire with no
 * delay and risked re-triggering the exact rate-limit lockout this
 * throttle exists to avoid. */
async function fetchAllDeepPrices(geckoIds: string[]): Promise<Map<string, ChartPricePoint[]>> {
  const result = new Map<string, ChartPricePoint[]>();
  const startEpoch = Math.floor(Date.now() / 1000) - DEEP_PRICE_DAYS * 86400;
  for (let i = 0; i < geckoIds.length; i += PRICE_BATCH_SIZE) {
    const batch = geckoIds.slice(i, i + PRICE_BATCH_SIZE);
    console.log(`  price batch ${Math.floor(i / PRICE_BATCH_SIZE) + 1}/${Math.ceil(geckoIds.length / PRICE_BATCH_SIZE)}...`);
    const batchResult = await fetchChartPrices(batch, startEpoch, DEEP_PRICE_DAYS);
    for (const [id, points] of batchResult) result.set(id, points);
  }
  return result;
}

/**
 * One-time historical backfill — run manually (`scripts/screener-backfill.ts`),
 * not on a schedule. Every row it writes gets `is_backfilled = true`
 * (PHASE_0.md §6/§8: this is deep but not necessarily point-in-time-safe
 * history, never conflated with the daily job's own true point-in-time
 * rows). Idempotent: skips any (asset, date) pair that already has a
 * backfilled row rather than duplicating it — enforced at the DB level
 * too now (see the partial unique index added at Phase 1 sign-off).
 *
 * A date that already has a row is left untouched even once DefiLlama
 * price coverage exists for it — deliberately NOT an update-in-place. An
 * earlier version of this function did exactly that (one SELECT+UPDATE
 * round trip per already-covered date) and at ~365 overlapping days ×
 * hundreds of assets that was thousands of sequential round trips for
 * marginal benefit; caught before it ran for hours, not after. DefiLlama's
 * price only ever wins for a genuinely NEW date (beyond CoinGecko's
 * 365-day reach) via the normal insert path — see fetchChartPrices'
 * own doc comment for the approved source split.
 */
export async function runScreenerBackfill(): Promise<BackfillResult> {
  const db = serviceDb();

  const assetRows = await fetchAllRows<{ id: string; gecko_id: string; defillama_slug: string | null }>(
    async (cursor, limit) =>
      db.from("screener_assets").select("id, gecko_id, defillama_slug").gt("id", cursor).order("id").limit(limit),
  );

  // Bulk-fetch existing backfilled rows up front, once — id kept (not just
  // presence) so a date that already has a row can be targeted for a
  // price-only UPDATE instead of skipped outright.
  const existing = await fetchAllRows<{ id: string; asset_id: string; observed_at: string }>(async (cursor, limit) =>
    db
      .from("screener_asset_snapshots")
      .select("id, asset_id, observed_at")
      .eq("is_backfilled", true)
      .gt("id", cursor)
      .order("id")
      .limit(limit),
  );
  const existingRowIds = new Map<string, string>(existing.map((r) => [`${r.asset_id}|${r.observed_at.slice(0, 10)}`, r.id]));

  const deepPricesByAsset = await fetchAllDeepPrices(assetRows.map((a) => a.gecko_id));

  const perAsset = await mapWithConcurrency(assetRows, CONCURRENCY, async (asset): Promise<BackfillAssetResult> => {
    try {
      const [feesHistory, revenueHistory, holdersRevenueHistory, marketHistory] = await Promise.all([
        asset.defillama_slug ? fetchProtocolFeeHistory(asset.defillama_slug, "dailyFees" as FeesDataType) : Promise.resolve([]),
        asset.defillama_slug
          ? fetchProtocolFeeHistory(asset.defillama_slug, "dailyRevenue" as FeesDataType)
          : Promise.resolve([]),
        asset.defillama_slug
          ? fetchProtocolFeeHistory(asset.defillama_slug, "dailyHoldersRevenue" as FeesDataType)
          : Promise.resolve([]),
        fetchHistoricalMarketData(asset.gecko_id, COINGECKO_MAX_DAYS),
      ]);
      const deepPrices = deepPricesByAsset.get(asset.gecko_id) ?? [];

      const fees30d = rollingSum(feesHistory, 30);
      const revenue30d = rollingSum(revenueHistory, 30);
      const holdersRevenue30d = rollingSum(holdersRevenueHistory, 30);
      const feesByDate = new Map(feesHistory.map((p) => [p.date, p.value]));
      const revenueByDate = new Map(revenueHistory.map((p) => [p.date, p.value]));
      const holdersRevenueByDate = new Map(holdersRevenueHistory.map((p) => [p.date, p.value]));

      const byDate = new Map<string, MergedDay>();
      function ensure(date: string): MergedDay {
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
      }
      // CoinGecko first (price fallback + the only mcap/volume source),
      // DefiLlama second so its price — deeper, now the approved primary
      // source — overwrites CoinGecko's for any date both cover.
      for (const p of marketHistory) {
        const row = ensure(p.date);
        row.price_usd = p.priceUsd;
        row.priceSource = "coingecko";
        row.market_cap_usd = p.marketCapUsd;
        row.volume_24h_usd = p.volume24hUsd;
      }
      for (const p of deepPrices) {
        const row = ensure(p.date);
        row.price_usd = p.priceUsd;
        row.priceSource = "defillama";
      }
      for (const [date, value] of feesByDate) {
        ensure(date).fees_24h = value;
      }
      for (const [date, value] of fees30d) {
        ensure(date).fees_30d = value;
      }
      for (const [date, value] of revenueByDate) {
        ensure(date).revenue_24h = value;
      }
      for (const [date, value] of revenue30d) {
        ensure(date).revenue_30d = value;
      }
      for (const [date, value] of holdersRevenueByDate) {
        ensure(date).holders_revenue_24h = value;
      }
      for (const [date, value] of holdersRevenue30d) {
        ensure(date).holders_revenue_30d = value;
      }

      const observedAtNow = new Date().toISOString();
      const priceProvenance = (row: MergedDay) =>
        row.priceSource === "defillama"
          ? { source: "defillama", endpoint: "/chart/coingecko:{id}", fetched_at: observedAtNow }
          : { source: "coingecko", endpoint: "/coins/{id}/market_chart", fetched_at: observedAtNow };

      const toInsert: Record<string, unknown>[] = [];

      for (const row of byDate.values()) {
        const existingId = existingRowIds.get(`${asset.id}|${row.date}`);
        if (!existingId) {
          toInsert.push({
            asset_id: asset.id,
            observed_at: `${row.date}T12:00:00.000Z`, // noon UTC — avoids date-boundary ambiguity, this row represents the whole day
            run_id: null,
            is_backfilled: true,
            price_usd: row.price_usd,
            market_cap_usd: row.market_cap_usd,
            volume_24h_usd: row.volume_24h_usd,
            fees_24h: row.fees_24h,
            fees_30d: row.fees_30d,
            revenue_24h: row.revenue_24h,
            revenue_30d: row.revenue_30d,
            holders_revenue_24h: row.holders_revenue_24h,
            holders_revenue_30d: row.holders_revenue_30d,
            provenance: {
              price_usd: priceProvenance(row),
              market_cap_usd: { source: "coingecko", endpoint: "/coins/{id}/market_chart", fetched_at: observedAtNow },
              volume_24h_usd: { source: "coingecko", endpoint: "/coins/{id}/market_chart", fetched_at: observedAtNow },
              fees_24h: {
                source: "defillama",
                endpoint: `/summary/fees/${asset.defillama_slug}?dataType=dailyFees`,
                fetched_at: observedAtNow,
              },
              fees_30d: {
                source: "defillama (rolling 30d sum of daily values, computed here)",
                endpoint: `/summary/fees/${asset.defillama_slug}?dataType=dailyFees`,
                fetched_at: observedAtNow,
              },
              revenue_24h: {
                source: "defillama",
                endpoint: `/summary/fees/${asset.defillama_slug}?dataType=dailyRevenue`,
                fetched_at: observedAtNow,
              },
              revenue_30d: {
                source: "defillama (rolling 30d sum of daily values, computed here)",
                endpoint: `/summary/fees/${asset.defillama_slug}?dataType=dailyRevenue`,
                fetched_at: observedAtNow,
              },
              holders_revenue_24h: {
                source: "defillama",
                endpoint: `/summary/fees/${asset.defillama_slug}?dataType=dailyHoldersRevenue`,
                fetched_at: observedAtNow,
              },
              holders_revenue_30d: {
                source: "defillama (rolling 30d sum of daily values, computed here)",
                endpoint: `/summary/fees/${asset.defillama_slug}?dataType=dailyHoldersRevenue`,
                fetched_at: observedAtNow,
              },
            },
          });
        }
        // A date that already has a row is left untouched, even if
        // DefiLlama now offers a price for it — deliberately not an
        // update-in-place. An earlier version of this function did
        // exactly that (one SELECT+UPDATE round trip per overlapping
        // date), and at ~365 overlapping days × hundreds of assets that
        // was thousands of sequential round trips for marginal benefit
        // (CoinGecko's own price for a date it already covers is already
        // a reasonable, real source — the actual value of the DefiLlama
        // switch is extending depth *beyond* CoinGecko's 365-day reach,
        // which the insert-only path above already covers). Caught before
        // it burned hours in production, not after.
      }

      // Chunked, not one insert for the whole asset — live-verified during
      // testing that a single-statement insert of a long-history asset's
      // full backfill (~1,800+ rows for a ~5-year DefiLlama history) hit a
      // Postgres statement timeout for at least one asset. 500/insert stays
      // comfortably under that regardless of how deep a given asset's
      // history goes.
      const INSERT_CHUNK_SIZE = 500;
      for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
        const { error: insertError } = await db
          .from("screener_asset_snapshots")
          .insert(toInsert.slice(i, i + INSERT_CHUNK_SIZE));
        if (insertError) throw new Error(insertError.message);
      }

      return {
        geckoId: asset.gecko_id,
        rowsInserted: toInsert.length,
        rowsSkippedExisting: byDate.size - toInsert.length,
        error: null,
      };
    } catch (e) {
      // One asset's failure never stops the rest — same "don't let one
      // ticker's failure touch another's" rule as sequentialWithSpacing.
      return { geckoId: asset.gecko_id, rowsInserted: 0, rowsSkippedExisting: 0, error: (e as Error).message };
    }
  });

  return {
    assetsProcessed: assetRows.length,
    totalRowsInserted: perAsset.reduce((sum, r) => sum + r.rowsInserted, 0),
    perAsset,
  };
}

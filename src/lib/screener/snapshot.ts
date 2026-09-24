import "server-only";
import { serviceDb } from "@/lib/supabase";
import { fetchMarketsByIds, type MarketDataRow } from "@/lib/adapters/coingecko";
import { fetchPricesAt } from "./adapters/defillamaPrices";
import { fetchProtocols, fetchFeesOverview, fetchParentProtocols } from "./adapters/defillama";
import { resolveGroups, aggregateGroupTotals, dominantCategory } from "./aggregate";
import { SCREENER_CONFIG } from "./config";
import { buildLiveRunProvenance } from "./provenance";
import { diffUnmatched, type UnmatchedEntry, type OpenUnmatchedRow } from "./unmatched";
import { fetchAllRows } from "./pagination";
import { findGapDates, type RunRow } from "./runSelection";

const BTC_GECKO_ID = "bitcoin";

// Rows per insert/upsert request. Also well under the Phase 1 statement-
// timeout ceiling that forced chunking in the backfill.
const WRITE_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// How many days back the gap detector checks on every run — cheap (one
// query over screener_runs), catches a missed day within a week of it
// happening rather than only when someone thinks to look.
const GAP_CHECK_DAYS = 14;

export interface SnapshotRunResult {
  runId: string;
  /** CoinGecko was unavailable: written from DefiLlama only (see degradedMarkets). */
  degraded: boolean;
  universeSize: number;
  matchedCount: number;
  unmatchedCount: number;
  conflictCount: number;
  gapDates: string[];
}

/** Detects missing days in the run log — a "runs itself daily" job that
 * silently stops running for a week produces a gap in the 30/90-day trend
 * history no later backfill can ever recover (point-in-time data, once
 * missed, is gone — see PHASE_0.md §6). Looks back GAP_CHECK_DAYS days from
 * today; a date with no `status = 'ok'` run row is a gap. Cheap (one query,
 * done in-memory) and run as part of every invocation's own execution so a
 * gap shows up in that run's own `notes` immediately. */
async function detectGaps(): Promise<string[]> {
  const db = serviceDb();
  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - GAP_CHECK_DAYS);

  const { data, error } = await db
    .from("screener_runs")
    .select("id, started_at, status, kind, degraded")
    .gte("started_at", since.toISOString())
    .eq("kind", "live") // a backfill run on a missed day must not mask the gap
    .eq("status", "ok");
  if (error) throw new Error(`Failed to check screener_runs for gap detection: ${error.message}`);
  // A degraded run (status ok) covers its day — see findGapDates.
  return findGapDates((data ?? []) as RunRow[], now, GAP_CHECK_DAYS);
}

// DefiLlama /prices/current takes its coin list in the URL path. Live-
// verified 2026-09-23: 200 coingecko:{id} keys (4.2 KB URL) -> 200, 250
// (5.3 KB) -> 400, 500+ -> 414. 100 per call is ~2 KB, half the known-good
// size, 7 calls for the current universe (each throttled 1.5s by fetchPricesAt).
const DEGRADED_PRICE_CHUNK = 100;

export interface Degradation {
  reason: "coingecko_unavailable";
  error: string;
  price_source: string;
  fields_null: string[];
  /** Resolved gecko_ids with no screener_assets row, so no name/ticker to
   * write without CoinGecko: mostly the ids CoinGecko has never had market
   * data for (the open no_coingecko_market_data intervals — 149 on
   * 2026-09-23), plus any genuinely new one, which waits for the next
   * complete run. */
  groups_skipped_not_in_assets: number;
  /** Known assets DefiLlama had no current price for (price null that day). */
  prices_missing: number;
}

/** When CoinGecko is unavailable (its /coins/markets call threw after the
 * shared retries and key failover), the day's snapshot is still written —
 * decided 2026-09-23: a partial day beats a missing one, because a missed
 * day of point-in-time history can never be recovered. Stand-in market rows
 * for every ALREADY-KNOWN asset: name/ticker from screener_assets, price
 * from DefiLlama's coins API (bitcoin included, so the BTC reference is from
 * the same response), and market cap / FDV / supply / volume null. Nulls
 * flow through as designed: core_data fails without market cap, so nothing
 * is rated that day, while fees/revenue/TVL history stays continuous. */
async function degradedMarkets(geckoIds: string[], error: string): Promise<{ markets: Map<string, MarketDataRow>; degradation: Degradation }> {
  const db = serviceDb();
  const known = new Map<string, { name: string; ticker: string }>();
  for (const batch of chunk(geckoIds, ID_CHUNK)) {
    const { data, error: readError } = await db.from("screener_assets").select("gecko_id, name, ticker").in("gecko_id", batch);
    if (readError) throw new Error(`Failed to read screener_assets for a degraded run: ${readError.message}`);
    for (const r of data ?? []) known.set(r.gecko_id as string, { name: r.name as string, ticker: r.ticker as string });
  }
  const priceIds = [...new Set([...known.keys(), BTC_GECKO_ID])];
  const prices = new Map<string, number>();
  for (const batch of chunk(priceIds, DEGRADED_PRICE_CHUNK)) {
    for (const [id, p] of await fetchPricesAt(batch)) prices.set(id, p);
  }
  const markets = new Map<string, MarketDataRow>();
  for (const id of priceIds) {
    const k = known.get(id) ?? { name: "Bitcoin", ticker: "btc" };
    markets.set(id, {
      id, name: k.name, symbol: k.ticker, imageUrl: null, price: prices.get(id) ?? null,
      change1h: null, change24h: null, change7d: null,
      marketCap: null, fdv: null, circulatingSupply: null, totalSupply: null, maxSupply: null, volume24h: null,
      fetchedAtMs: Date.now(), // fetchPricesAt just ran, live
    });
  }
  return {
    markets,
    degradation: {
      reason: "coingecko_unavailable",
      error,
      price_source: "defillama coins.llama.fi /prices/current (coingecko:{gecko_id})",
      fields_null: ["market_cap_usd", "fdv_usd", "circulating_supply", "total_supply", "max_supply", "volume_24h_usd"],
      groups_skipped_not_in_assets: geckoIds.filter((id) => id !== BTC_GECKO_ID && !known.has(id)).length,
      prices_missing: [...known.keys()].filter((id) => !prices.has(id)).length,
    },
  };
}

// PostgREST `in.(...)` filters go in the URL — keep each request's id list
// well under typical URL-length limits (36-char uuids).
const ID_CHUNK = 100;

/** Writes only what changed since the last run to `screener_unmatched`
 * (see unmatched.ts): opens new intervals, closes resolved ones, refreshes
 * changed reason text. Returns the counts for the run's own notes. */
async function recordUnmatchedChanges(
  runId: string,
  current: UnmatchedEntry[],
  ignoreKinds: UnmatchedEntry["kind"][] = [],
): Promise<{ opened: number; resolved: number; reason_updated: number; open_total: number }> {
  const db = serviceDb();
  const open = await fetchAllRows<OpenUnmatchedRow>(async (cursor, limit) =>
    db
      .from("screener_unmatched")
      .select("id, kind, identifier, reason")
      .is("resolved_run_id", null)
      .gt("id", cursor)
      .order("id")
      .limit(limit),
  );
  const diff = diffUnmatched(open, current, ignoreKinds);
  const now = new Date().toISOString();

  for (let i = 0; i < diff.toOpen.length; i += 500) {
    const { error } = await db.from("screener_unmatched").insert(
      diff.toOpen.slice(i, i + 500).map((u) => ({
        kind: u.kind,
        identifier: u.identifier,
        reason: u.reason,
        first_seen_run_id: runId,
        first_seen_at: now,
      })),
    );
    if (error) throw new Error(`Failed to open screener_unmatched rows: ${error.message}`);
  }
  for (let i = 0; i < diff.toResolveIds.length; i += ID_CHUNK) {
    const { error } = await db
      .from("screener_unmatched")
      .update({ resolved_run_id: runId, resolved_at: now })
      .in("id", diff.toResolveIds.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`Failed to resolve screener_unmatched rows: ${error.message}`);
  }
  // Grouped by new reason text, not one request per row — most reasons are
  // fixed strings, so a wording change would otherwise mean thousands of
  // sequential PATCHes inside a 300s cron budget.
  const idsByReason = new Map<string, string[]>();
  for (const u of diff.reasonUpdates) idsByReason.set(u.reason, [...(idsByReason.get(u.reason) ?? []), u.id]);
  for (const [reason, ids] of idsByReason) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { error } = await db.from("screener_unmatched").update({ reason }).in("id", ids.slice(i, i + ID_CHUNK));
      if (error) throw new Error(`Failed to update screener_unmatched reason: ${error.message}`);
    }
  }

  return {
    opened: diff.toOpen.length,
    resolved: diff.toResolveIds.length,
    reason_updated: diff.reasonUpdates.length,
    open_total: open.length + diff.toOpen.length - diff.toResolveIds.length,
  };
}

/**
 * The daily snapshot job (Phase 1's most time-sensitive deliverable — every
 * day this isn't running is a day of point-in-time history that can never
 * be recovered). Builds the universe fresh every run (no separate cached
 * "universe" step — DefiLlama's protocol list itself changes day to day,
 * re-deriving it is cheap: 5 DefiLlama calls total, regardless of universe
 * size, see adapters/defillama.ts's own doc comments), resolves each
 * protocol to its real gecko_id (own or via parent, see aggregate.ts's resolveGroups),
 * joins to CoinGecko, writes one append-only screener_asset_snapshots row
 * per matched asset, flags source conflicts, and logs everything unmatched
 * rather than dropping it silently (Phase 1 spec, and CLAUDE.md's Data
 * Correctness rule generally).
 */
export interface SnapshotInvocation {
  /** "vercel-cron" when the request carried Vercel's own x-vercel-cron-
   * schedule header (set on both a real scheduled firing and a manual
   * `vercel crons run` — see route.ts's own doc comment for how to tell
   * those apart using started_at), "unknown" for anything else (a local
   * script, a hand-crafted request with the right CRON_SECRET). Recorded
   * into screener_runs.notes on every invocation, including one that
   * fails before finishing — this is what makes cron-firing evidence
   * outlive Vercel's own log retention window. */
  trigger: "vercel-cron" | "unknown";
  cronScheduleHeader: string | null;
}

export async function runScreenerSnapshot(
  invocation?: SnapshotInvocation,
  /** Test-only: take the degraded path without calling CoinGecko, with this
   * text as the recorded error. The cron route never passes it; it exists
   * because CoinGecko serves an invalid Demo key as the public tier (live-
   * checked 2026-09-23), so an outage can't be simulated from outside. Used
   * by scripts/diag/screener-live-run.ts --force-degraded. */
  opts: { forceDegraded?: string } = {},
): Promise<SnapshotRunResult> {
  const db = serviceDb();
  const startedAt = new Date().toISOString();
  const invocationNotes = invocation
    ? { trigger: invocation.trigger, cron_schedule_header: invocation.cronScheduleHeader }
    : { trigger: "unknown" as const, cron_schedule_header: null };

  const { data: runRow, error: runInsertError } = await db
    .from("screener_runs")
    .insert({ started_at: startedAt, kind: "live", status: "running", notes: invocationNotes })
    .select("id")
    .single();
  if (runInsertError) throw new Error(`Failed to start screener_runs: ${runInsertError.message}`);
  const runId = runRow.id as string;

  try {
    const [protocols, fees, revenue, holdersRevenue, parents] = await Promise.all([
      fetchProtocols(),
      fetchFeesOverview("dailyFees"),
      fetchFeesOverview("dailyRevenue"),
      fetchFeesOverview("dailyHoldersRevenue"),
      fetchParentProtocols(),
    ]);

    const unmatched: UnmatchedEntry[] = [];

    // Fee-bearing candidates first (gecko_id resolution happens after —
    // resolveGroups needs both own and parent gecko_id, and a protocol
    // with neither is genuinely out of scope, not "unmatched": that's the
    // scope note itself, PHASE_0.md §8 #7, not a data-quality gap).
    const candidates = protocols.filter((p) => {
      if (!fees.has(p.slug)) {
        unmatched.push({
          kind: "no_fee_data",
          identifier: p.slug,
          reason: "No entry in DefiLlama /overview/fees",
        });
        return false;
      }
      return true;
    });

    const { groups, unresolved } = resolveGroups(candidates, parents);
    for (const p of unresolved) {
      unmatched.push({
        kind: "no_gecko_id",
        identifier: p.slug,
        reason: p.parentProtocol
          ? `Has fee data but neither its own gecko_id nor its parent (${p.parentProtocol}) has one`
          : "Has fee data but no gecko_id and no parentProtocol to resolve through",
      });
    }

    // BTC rides along in the same /coins/markets call: Phase 2b pairs each
    // live asset price with a BTC price read at the SAME moment (SPEC
    // standing rule, levels case), and the same response is as same-moment
    // as it gets. (BTC is also a universe asset itself — DefiLlama lists a
    // `bitcoin` protocol — hence the Set: it's fetched once either way.)
    const geckoIds = [...new Set([...groups.keys(), BTC_GECKO_ID])];
    let marketByGeckoId: Map<string, MarketDataRow>;
    let degradation: Degradation | null = null;
    try {
      if (opts.forceDegraded) throw new Error(opts.forceDegraded);
      marketByGeckoId = new Map((await fetchMarketsByIds(geckoIds)).map((r) => [r.id, r]));
    } catch (e) {
      console.warn(`[screener] CoinGecko unavailable for run ${runId}; writing a degraded snapshot: ${(e as Error).message}`);
      ({ markets: marketByGeckoId, degradation } = await degradedMarkets(geckoIds, (e as Error).message));
    }
    const btcMarket = marketByGeckoId.get(BTC_GECKO_ID);
    const referencePrices =
      btcMarket?.price != null
        ? {
            [BTC_GECKO_ID]: {
              price_usd: btcMarket.price,
              source: degradation
                ? "defillama /prices/current (degraded run; same response as the asset prices)"
                : "coingecko /coins/markets (same response as the asset prices)",
            },
          }
        : {};

    const observedAt = new Date().toISOString();

    // One provenance manifest for the whole run (see provenance.ts) —
    // written before any snapshot row so a run that fails partway still
    // has provenance for the rows it did write.
    const { error: provenanceError } = await db
      .from("screener_runs")
      .update({ provenance: buildLiveRunProvenance(observedAt, { degraded: degradation !== null }) })
      .eq("id", runId);
    if (provenanceError) throw new Error(`Failed to write screener_runs.provenance(${runId}): ${provenanceError.message}`);

    // Batched writes (chunks of WRITE_CHUNK): this loop used to do two
    // sequential round trips per asset (upsert + insert) — 173s of the
    // route's 300s budget for 682 assets, measured 2026-09-22 — leaving no
    // room for the Phase 2 derivation step in the same invocation.
    const categoryBySlug = new Map(candidates.map((p) => [p.slug, p.category]));
    const prepared = [];
    for (const group of groups.values()) {
      const market = marketByGeckoId.get(group.geckoId);
      // A degraded run never asked CoinGecko, so a missing row there means
      // "not yet a known asset", not "CoinGecko has no market data" (counted
      // in the degradation note instead).
      if (!market && degradation) continue;
      if (!market) {
        unmatched.push({
          kind: "no_coingecko_market_data",
          identifier: group.geckoId,
          reason: `Resolved gecko_id "${group.geckoId}" (from DefiLlama slug(s): ${group.contributingSlugs.join(", ")}) but CoinGecko returned no market row for it (delisted, renamed, or a bad id)`,
        });
        continue;
      }
      const sector = dominantCategory(
        group.contributingSlugs,
        categoryBySlug,
        (s) => revenue.get(s)?.total30d,
        (s) => fees.get(s)?.total30d,
      );
      prepared.push({ group, market, sector, totals: aggregateGroupTotals(group.contributingSlugs, fees, revenue, holdersRevenue) });
    }

    const assetIdByGeckoId = new Map<string, string>();
    for (const batch of chunk(prepared, WRITE_CHUNK)) {
      const { data, error } = await db
        .from("screener_assets")
        .upsert(
          batch.map(({ group, market, sector }) => ({
            gecko_id: group.geckoId,
            defillama_slug: group.contributingSlugs[0],
            name: market.name,
            ticker: market.symbol,
            sector,
            last_seen_at: observedAt,
          })),
          { onConflict: "gecko_id" },
        )
        .select("id, gecko_id");
      if (error) throw new Error(`Failed to upsert screener_assets: ${error.message}`);
      for (const row of data as { id: string; gecko_id: string }[]) assetIdByGeckoId.set(row.gecko_id, row.id);
    }
    const assetIdFor = (geckoId: string): string => {
      const id = assetIdByGeckoId.get(geckoId);
      if (!id) throw new Error(`screener_assets upsert returned no id for ${geckoId}`);
      return id;
    };

    // Conflict check: DefiLlama's own mcap (the parent's aggregate when this
    // group rolled up through one) vs. CoinGecko's market_cap. CoinGecko's
    // is what gets written to market_cap_usd; this only flags the
    // disagreement, never resolves it silently (build-prompt principle #4).
    const conflicts = prepared.flatMap(({ group, market }) => {
      if (group.mcapForConflictCheck === null || market.marketCap === null || !(group.mcapForConflictCheck > 0)) return [];
      const pctDiff = (Math.abs(group.mcapForConflictCheck - market.marketCap) / group.mcapForConflictCheck) * 100;
      if (pctDiff <= SCREENER_CONFIG.conflictThresholdPct) return [];
      return [
        {
          asset_id: assetIdFor(group.geckoId),
          observed_at: observedAt,
          field_name: "market_cap_usd",
          source_a: "defillama",
          value_a: group.mcapForConflictCheck,
          source_b: "coingecko",
          value_b: market.marketCap,
          pct_diff: pctDiff,
          run_id: runId,
        },
      ];
    });
    for (const batch of chunk(conflicts, WRITE_CHUNK)) {
      const { error } = await db.from("screener_field_conflicts").insert(batch);
      if (error) throw new Error(`Failed to log screener_field_conflicts: ${error.message}`);
    }
    const conflictCount = conflicts.length;

    for (const batch of chunk(prepared, WRITE_CHUNK)) {
      const { error } = await db.from("screener_asset_snapshots").insert(
        batch.map(({ group, market, totals }) => ({
          asset_id: assetIdFor(group.geckoId),
          observed_at: observedAt,
          run_id: runId,
          is_backfilled: false,
          price_usd: market.price,
          market_cap_usd: market.marketCap,
          fdv_usd: market.fdv,
          circulating_supply: market.circulatingSupply,
          total_supply: market.totalSupply,
          max_supply: market.maxSupply,
          tvl_usd: group.tvl,
          fees_24h: totals.fees24h,
          fees_7d: totals.fees7d,
          fees_30d: totals.fees30d,
          fees_1y: totals.fees1y,
          revenue_24h: totals.revenue24h,
          revenue_7d: totals.revenue7d,
          revenue_30d: totals.revenue30d,
          revenue_1y: totals.revenue1y,
          holders_revenue_24h: totals.holdersRevenue24h,
          holders_revenue_30d: totals.holdersRevenue30d,
          volume_24h_usd: market.volume24h,
          contributing_slugs: group.contributingSlugs,
        })),
      );
      if (error) throw new Error(`Failed to write screener_asset_snapshots: ${error.message}`);
    }
    const matchedCount = prepared.length;

    const unmatchedChanges = await recordUnmatchedChanges(runId, unmatched, degradation ? ["no_coingecko_market_data"] : []);

    const gapDates = await detectGaps();

    const { error: finishError } = await db
      .from("screener_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "ok",
        degraded: degradation !== null,
        universe_size: groups.size,
        matched_count: matchedCount,
        unmatched_count: unmatched.length,
        notes: {
          ...invocationNotes,
          conflict_count: conflictCount,
          gap_dates: gapDates,
          unmatched_changes: unmatchedChanges,
          reference_prices: referencePrices,
          ...(degradation ? { degradation } : {}),
        },
      })
      .eq("id", runId);
    if (finishError) throw new Error(`Failed to finalize screener_runs(${runId}): ${finishError.message}`);

    return {
      runId,
      degraded: degradation !== null,
      universeSize: groups.size,
      matchedCount,
      unmatchedCount: unmatched.length,
      conflictCount,
      gapDates,
    };
  } catch (e) {
    await db
      .from("screener_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "error",
        notes: { ...invocationNotes, error: (e as Error).message },
      })
      .eq("id", runId);
    throw e;
  }
}

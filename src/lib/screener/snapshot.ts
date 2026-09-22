import "server-only";
import { serviceDb } from "@/lib/supabase";
import { fetchMarketsByIds } from "@/lib/adapters/coingecko";
import { fetchProtocols, fetchFeesOverview, fetchParentProtocols } from "./adapters/defillama";
import { resolveGroups, aggregateGroupTotals, dominantCategory } from "./aggregate";
import { SCREENER_CONFIG } from "./config";
import { buildLiveRunProvenance } from "./provenance";
import { diffUnmatched, type UnmatchedEntry, type OpenUnmatchedRow } from "./unmatched";
import { fetchAllRows } from "./pagination";

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
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - GAP_CHECK_DAYS);

  const { data, error } = await db
    .from("screener_runs")
    .select("started_at, status")
    .gte("started_at", since.toISOString())
    .eq("kind", "live") // a backfill run on a missed day must not mask the gap
    .eq("status", "ok");
  if (error) throw new Error(`Failed to check screener_runs for gap detection: ${error.message}`);

  const successDates = new Set((data as { started_at: string }[]).map((r) => r.started_at.slice(0, 10)));
  const gaps: string[] = [];
  for (let i = 1; i < GAP_CHECK_DAYS; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    if (!successDates.has(dateStr)) gaps.push(dateStr);
  }
  return gaps;
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
  const diff = diffUnmatched(open, current);
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

export async function runScreenerSnapshot(invocation?: SnapshotInvocation): Promise<SnapshotRunResult> {
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
    // as it gets. BTC has no fee data, so it's never a universe row itself.
    const geckoIds = [...new Set([...groups.keys(), BTC_GECKO_ID])];
    const marketRows = await fetchMarketsByIds(geckoIds);
    const marketByGeckoId = new Map(marketRows.map((r) => [r.id, r]));
    const btcMarket = marketByGeckoId.get(BTC_GECKO_ID);
    const referencePrices =
      btcMarket?.price != null
        ? { [BTC_GECKO_ID]: { price_usd: btcMarket.price, source: "coingecko /coins/markets (same response as the asset prices)" } }
        : {};

    const observedAt = new Date().toISOString();

    // One provenance manifest for the whole run (see provenance.ts) —
    // written before any snapshot row so a run that fails partway still
    // has provenance for the rows it did write.
    const { error: provenanceError } = await db
      .from("screener_runs")
      .update({ provenance: buildLiveRunProvenance(observedAt) })
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

    const unmatchedChanges = await recordUnmatchedChanges(runId, unmatched);

    const gapDates = await detectGaps();

    const { error: finishError } = await db
      .from("screener_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "ok",
        universe_size: groups.size,
        matched_count: matchedCount,
        unmatched_count: unmatched.length,
        notes: {
          ...invocationNotes,
          conflict_count: conflictCount,
          gap_dates: gapDates,
          unmatched_changes: unmatchedChanges,
          reference_prices: referencePrices,
        },
      })
      .eq("id", runId);
    if (finishError) throw new Error(`Failed to finalize screener_runs(${runId}): ${finishError.message}`);

    return {
      runId,
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

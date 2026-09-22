import "server-only";
import { serviceDb } from "@/lib/supabase";
import { fetchMarketsByIds } from "@/lib/adapters/coingecko";
import {
  fetchProtocols,
  fetchFeesOverview,
  fetchParentProtocols,
  type DefiLlamaProtocol,
  type ProtocolFeeTotals,
} from "./adapters/defillama";

// Configurable per CLAUDE.md/build-prompt principle #9 ("all thresholds and
// weights live in one config file") — inlined here for now since Phase 1
// has no config file of its own yet and this is the only threshold Phase 1
// needs; move into a real screener.config.ts alongside Phase 2's gate/tier
// thresholds and Phase 3's weights rather than letting this become the
// first of several scattered constants.
const CONFLICT_THRESHOLD_PCT = 5;

// How many days back the gap detector checks on every run — cheap (one
// query over screener_runs), catches a missed day within a week of it
// happening rather than only when someone thinks to look.
const GAP_CHECK_DAYS = 14;

interface UnmatchedEntry {
  kind: "no_gecko_id" | "no_fee_data" | "no_coingecko_market_data";
  identifier: string;
  reason: string;
}

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

/** Sums the non-null values; null only if every input was null — a
 * protocol group with SOME children reporting a metric and others not
 * still gets a real (partial) sum, but a group where nothing at all is
 * known for that metric stays null rather than becoming a fabricated 0
 * (build-prompt principle #2). */
function sumOrNull(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0);
}

interface ResolvedGroup {
  geckoId: string;
  /** DefiLlama identifiers whose data was summed into this group — a
   * parent id ("parent#uniswap") when resolved via a parent protocol, or
   * a single protocol's own slug otherwise. Recorded in provenance, not a
   * schema column, since it's a list not a scalar. */
  contributingSlugs: string[];
  category: string | null;
  /** DefiLlama's own mcap for the conflict-detection check — the parent's
   * own aggregate figure when parent-resolved (DefiLlama already computes
   * this correctly at that level; summing children's own mcap fields
   * would double-count overlapping supply across versions), otherwise the
   * single protocol's own mcap. */
  mcapForConflictCheck: number | null;
  tvl: number | null;
  fees24h: number | null;
  fees7d: number | null;
  fees30d: number | null;
  fees1y: number | null;
  revenue24h: number | null;
  revenue7d: number | null;
  revenue30d: number | null;
  revenue1y: number | null;
  holdersRevenue24h: number | null;
  holdersRevenue30d: number | null;
}

/**
 * Resolves each fee-bearing DefiLlama protocol to the gecko_id it should
 * actually be priced/valued under, and groups by that id — DefiLlama
 * commonly splits a major protocol into versioned/product-line children
 * (Uniswap V1/V2/V3/V4, GMX V1/V2 Perps/AMM, Hyperliquid Bridge/Spot/HLP/
 * Perps) that carry NO gecko_id of their own; the id lives only on a
 * separate parent-aggregate resource (see fetchParentProtocols). Without
 * this resolution step, three of the highest-revenue protocols that exist
 * — Uniswap, Hyperliquid, GMX — were silently entirely absent from the
 * universe (live-verified during Phase 1 build/test, not a hypothetical).
 * A protocol resolves via its own gecko_id when it has one directly
 * (e.g. Aave's "aave-v2" slug does); only falls back to its parent when
 * its own is null AND the parent itself has a gecko_id.
 */
function resolveAndGroup(
  candidates: DefiLlamaProtocol[],
  parents: Map<string, { geckoId: string | null; mcap: number | null }>,
  fees: Map<string, ProtocolFeeTotals>,
  revenue: Map<string, ProtocolFeeTotals>,
  holdersRevenue: Map<string, ProtocolFeeTotals>,
): { groups: Map<string, ResolvedGroup>; unresolved: DefiLlamaProtocol[] } {
  const groups = new Map<string, ResolvedGroup>();
  const unresolved: DefiLlamaProtocol[] = [];

  for (const protocol of candidates) {
    let geckoId = protocol.geckoId;
    let mcapSource = protocol.mcap;
    if (!geckoId && protocol.parentProtocol) {
      const parent = parents.get(protocol.parentProtocol);
      if (parent?.geckoId) {
        geckoId = parent.geckoId;
        mcapSource = parent.mcap;
      }
    }
    if (!geckoId) {
      unresolved.push(protocol);
      continue;
    }

    const f = fees.get(protocol.slug);
    const r = revenue.get(protocol.slug);
    const h = holdersRevenue.get(protocol.slug);

    const existing = groups.get(geckoId);
    if (!existing) {
      groups.set(geckoId, {
        geckoId,
        contributingSlugs: [protocol.slug],
        category: protocol.category,
        mcapForConflictCheck: mcapSource,
        tvl: protocol.tvl,
        fees24h: f?.total24h ?? null,
        fees7d: f?.total7d ?? null,
        fees30d: f?.total30d ?? null,
        fees1y: f?.total1y ?? null,
        revenue24h: r?.total24h ?? null,
        revenue7d: r?.total7d ?? null,
        revenue30d: r?.total30d ?? null,
        revenue1y: r?.total1y ?? null,
        holdersRevenue24h: h?.total24h ?? null,
        holdersRevenue30d: h?.total30d ?? null,
      });
    } else {
      existing.contributingSlugs.push(protocol.slug);
      existing.category ??= protocol.category;
      // Parent's own mcap (already set once, correctly) is never
      // overwritten by a child's own mcap field — see mcapForConflictCheck's
      // own doc comment on why summing/replacing it would double-count.
      existing.tvl = sumOrNull([existing.tvl, protocol.tvl]);
      existing.fees24h = sumOrNull([existing.fees24h, f?.total24h]);
      existing.fees7d = sumOrNull([existing.fees7d, f?.total7d]);
      existing.fees30d = sumOrNull([existing.fees30d, f?.total30d]);
      existing.fees1y = sumOrNull([existing.fees1y, f?.total1y]);
      existing.revenue24h = sumOrNull([existing.revenue24h, r?.total24h]);
      existing.revenue7d = sumOrNull([existing.revenue7d, r?.total7d]);
      existing.revenue30d = sumOrNull([existing.revenue30d, r?.total30d]);
      existing.revenue1y = sumOrNull([existing.revenue1y, r?.total1y]);
      existing.holdersRevenue24h = sumOrNull([existing.holdersRevenue24h, h?.total24h]);
      existing.holdersRevenue30d = sumOrNull([existing.holdersRevenue30d, h?.total30d]);
    }
  }

  return { groups, unresolved };
}

/**
 * The daily snapshot job (Phase 1's most time-sensitive deliverable — every
 * day this isn't running is a day of point-in-time history that can never
 * be recovered). Builds the universe fresh every run (no separate cached
 * "universe" step — DefiLlama's protocol list itself changes day to day,
 * re-deriving it is cheap: 5 DefiLlama calls total, regardless of universe
 * size, see adapters/defillama.ts's own doc comments), resolves each
 * protocol to its real gecko_id (own or via parent, see resolveAndGroup),
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
    .insert({ started_at: startedAt, status: "running", notes: invocationNotes })
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
    // resolveAndGroup needs both own and parent gecko_id, and a protocol
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

    const { groups, unresolved } = resolveAndGroup(candidates, parents, fees, revenue, holdersRevenue);
    for (const p of unresolved) {
      unmatched.push({
        kind: "no_gecko_id",
        identifier: p.slug,
        reason: p.parentProtocol
          ? `Has fee data but neither its own gecko_id nor its parent (${p.parentProtocol}) has one`
          : "Has fee data but no gecko_id and no parentProtocol to resolve through",
      });
    }

    const geckoIds = [...groups.keys()];
    const marketRows = await fetchMarketsByIds(geckoIds);
    const marketByGeckoId = new Map(marketRows.map((r) => [r.id, r]));

    const observedAt = new Date().toISOString();
    let matchedCount = 0;
    let conflictCount = 0;

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

      const { data: assetRow, error: assetError } = await db
        .from("screener_assets")
        .upsert(
          {
            gecko_id: group.geckoId,
            defillama_slug: group.contributingSlugs[0],
            name: market.name,
            ticker: market.symbol,
            sector: group.category,
            last_seen_at: observedAt,
          },
          { onConflict: "gecko_id" },
        )
        .select("id")
        .single();
      if (assetError) throw new Error(`Failed to upsert screener_assets(${group.geckoId}): ${assetError.message}`);
      const assetId = assetRow.id as string;

      // Conflict check: DefiLlama's own mcap (the parent's own aggregate
      // figure when this group rolled up through one) vs. CoinGecko's
      // market_cap — the two sources' own figures can genuinely disagree
      // (different methodology, different refresh cadence). CoinGecko's
      // is what actually gets written to market_cap_usd below (it's the
      // more broadly-scoped source of truth this app already trusts
      // elsewhere); this only flags the disagreement, never resolves it
      // silently (build-prompt principle #4).
      if (group.mcapForConflictCheck !== null && market.marketCap !== null && group.mcapForConflictCheck > 0) {
        const pctDiff = (Math.abs(group.mcapForConflictCheck - market.marketCap) / group.mcapForConflictCheck) * 100;
        if (pctDiff > CONFLICT_THRESHOLD_PCT) {
          conflictCount++;
          const { error: conflictError } = await db.from("screener_field_conflicts").insert({
            asset_id: assetId,
            observed_at: observedAt,
            field_name: "market_cap_usd",
            source_a: "defillama",
            value_a: group.mcapForConflictCheck,
            source_b: "coingecko",
            value_b: market.marketCap,
            pct_diff: pctDiff,
            run_id: runId,
          });
          if (conflictError)
            throw new Error(`Failed to log screener_field_conflicts(${group.geckoId}): ${conflictError.message}`);
        }
      }

      const fetchedAt = observedAt;
      const defiLlamaProvenance = (endpoint: string) => ({
        source: "defillama",
        endpoint,
        contributing_slugs: group.contributingSlugs,
        fetched_at: fetchedAt,
      });
      const provenance = {
        price_usd: { source: "coingecko", endpoint: "/coins/markets", fetched_at: fetchedAt },
        market_cap_usd: { source: "coingecko", endpoint: "/coins/markets", fetched_at: fetchedAt },
        fdv_usd: { source: "coingecko", endpoint: "/coins/markets", fetched_at: fetchedAt },
        circulating_supply: { source: "coingecko", endpoint: "/coins/markets", fetched_at: fetchedAt },
        total_supply: { source: "coingecko", endpoint: "/coins/markets", fetched_at: fetchedAt },
        max_supply: { source: "coingecko", endpoint: "/coins/markets", fetched_at: fetchedAt },
        volume_24h_usd: { source: "coingecko", endpoint: "/coins/markets", fetched_at: fetchedAt },
        tvl_usd: defiLlamaProvenance("/protocols"),
        fees_24h: defiLlamaProvenance("/overview/fees?dataType=dailyFees"),
        fees_7d: defiLlamaProvenance("/overview/fees?dataType=dailyFees"),
        fees_30d: defiLlamaProvenance("/overview/fees?dataType=dailyFees"),
        fees_1y: defiLlamaProvenance("/overview/fees?dataType=dailyFees"),
        revenue_24h: defiLlamaProvenance("/overview/fees?dataType=dailyRevenue"),
        revenue_7d: defiLlamaProvenance("/overview/fees?dataType=dailyRevenue"),
        revenue_30d: defiLlamaProvenance("/overview/fees?dataType=dailyRevenue"),
        revenue_1y: defiLlamaProvenance("/overview/fees?dataType=dailyRevenue"),
        holders_revenue_24h: defiLlamaProvenance("/overview/fees?dataType=dailyHoldersRevenue"),
        holders_revenue_30d: defiLlamaProvenance("/overview/fees?dataType=dailyHoldersRevenue"),
      };

      const { error: snapshotError } = await db.from("screener_asset_snapshots").insert({
        asset_id: assetId,
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
        fees_24h: group.fees24h,
        fees_7d: group.fees7d,
        fees_30d: group.fees30d,
        fees_1y: group.fees1y,
        revenue_24h: group.revenue24h,
        revenue_7d: group.revenue7d,
        revenue_30d: group.revenue30d,
        revenue_1y: group.revenue1y,
        holders_revenue_24h: group.holdersRevenue24h,
        holders_revenue_30d: group.holdersRevenue30d,
        volume_24h_usd: market.volume24h,
        provenance,
      });
      if (snapshotError) throw new Error(`Failed to write screener_asset_snapshots(${group.geckoId}): ${snapshotError.message}`);

      matchedCount++;
    }

    if (unmatched.length > 0) {
      const { error: unmatchedError } = await db
        .from("screener_unmatched_log")
        .insert(unmatched.map((u) => ({ run_id: runId, kind: u.kind, identifier: u.identifier, reason: u.reason })));
      if (unmatchedError) throw new Error(`Failed to write screener_unmatched_log: ${unmatchedError.message}`);
    }

    const gapDates = await detectGaps();

    const { error: finishError } = await db
      .from("screener_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "ok",
        universe_size: groups.size,
        matched_count: matchedCount,
        unmatched_count: unmatched.length,
        notes: { ...invocationNotes, conflict_count: conflictCount, gap_dates: gapDates },
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

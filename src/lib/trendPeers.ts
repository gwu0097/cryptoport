import "server-only";
import {
  fetchSeedInfo,
  fetchCategoryStats,
  fetchCategoryMembers,
  fetchMarketsByIds,
  searchCoins,
  type SeedInfo,
  type CategoryStat,
} from "./adapters/coingecko";
import { explainTrend, type TrendExplanation, type AiPeerTicker } from "./adapters/perplexity";
import { rankPeers, matchCategoryName, type PeerRow } from "./trendFinder";
import { pickBestMatch } from "./watchlistInput";
import { serviceDb } from "./supabase";
import { JOB_STALE_MS } from "./jobStatus";

export interface TrendExplanationRow {
  status: string | null;
  startedAt: string | null;
  /** When this explanation was last (re)computed — shown next to "Why is
   * this moving" so a viewer can tell a same-day scan from an old one.
   * Global/shared across all users, same table as everything else here. */
  computedAt: string | null;
  /** null until the first successful scan ever completes — a claimed-but-
   * still-running or never-attempted token has nothing to show yet. */
  data: TrendExplanation | null;
}

interface RawExplanationRow {
  status: string | null;
  started_at: string | null;
  reason_summary: string | null;
  narrative_tags: string[] | null;
  category_guess: string | null;
  ai_tickers: AiPeerTicker[] | null;
  confidence: "high" | "medium" | "low" | null;
  sources: { title: string; url: string }[] | null;
  computed_at: string | null;
}

function toTrendExplanationRow(row: RawExplanationRow): TrendExplanationRow {
  const hasData = row.reason_summary !== null;
  return {
    status: row.status,
    startedAt: row.started_at,
    computedAt: row.computed_at,
    data: hasData
      ? {
          reasonSummary: row.reason_summary!,
          narrativeTags: row.narrative_tags ?? [],
          categoryGuess: row.category_guess,
          aiTickers: row.ai_tickers ?? [],
          confidence: row.confidence ?? "low",
          sources: row.sources ?? [],
        }
      : null,
  };
}

/**
 * Read-only, on-demand cache read — no TTL, no auto-recompute. A
 * previously-scanned token's explanation is reused forever until a user
 * explicitly clicks Refresh (see claimTrendExplanation/runTrendExplanation
 * below). This replaces the old 24h-TTL silent-recompute design: that was
 * the actual cause of "I thought we said everything should be stored" — a
 * token that had genuinely been searched before still paid a live 20-30s
 * Perplexity call on a plain page load once its row crossed 24h old. See
 * CLAUDE.md's Caching section — research artifacts are stored once and
 * reused until asked for a refresh, same as token_analyses.
 */
export async function getTrendExplanation(seedId: string): Promise<TrendExplanationRow> {
  const { data, error } = await serviceDb()
    .from("trend_explanations")
    .select(
      "status, started_at, reason_summary, narrative_tags, category_guess, ai_tickers, confidence, sources, computed_at",
    )
    .eq("seed_id", seedId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load trend_explanations: ${error.message}`);
  if (!data) return { status: null, startedAt: null, computedAt: null, data: null };
  return toTrendExplanationRow(data as RawExplanationRow);
}

/**
 * CAS claim, same "update a stale/idle row, or insert if none exists yet"
 * shape as tokenAnalysis.ts's claimTokenAnalysis — see that function's own
 * doc comment for why a plain UPDATE...WHERE can't tell "doesn't exist"
 * from "already running" on its own. `status: "refreshing"` is
 * deliberately one of jobStatus.ts's own IN_PROGRESS_STATUSES strings.
 */
export async function claimTrendExplanation(seedId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();

  const { data: claimed, error: updateError } = await serviceDb()
    .from("trend_explanations")
    .update({ status: "refreshing", started_at: nowIso })
    .eq("seed_id", seedId)
    .or(`status.is.null,status.neq.refreshing,started_at.lt.${staleBefore}`)
    .select("seed_id");
  if (updateError) throw new Error(`Failed to claim trend_explanations: ${updateError.message}`);
  if (claimed && claimed.length > 0) return true;

  const { data: existing, error: existingError } = await serviceDb()
    .from("trend_explanations")
    .select("seed_id")
    .eq("seed_id", seedId)
    .maybeSingle();
  if (existingError) throw new Error(`Failed to check trend_explanations: ${existingError.message}`);
  if (existing) return false; // genuinely already running, not stale — someone else has the claim

  const { error: insertError } = await serviceDb()
    .from("trend_explanations")
    .insert({ seed_id: seedId, status: "refreshing", started_at: nowIso });
  if (insertError) {
    // A unique-violation here means another request's own insert won the
    // race between our existence check and this insert.
    if (insertError.code === "23505") return false;
    throw new Error(`Failed to claim trend_explanations: ${insertError.message}`);
  }
  return true;
}

/** The actual Perplexity call + write — only ever invoked from inside a
 * Server Action's after() (see trend-finder/actions.ts's
 * refreshTrendExplanation), never awaited directly, matching every other
 * slow job in this app (CLAUDE.md's Loading Feedback section). Failure
 * still writes a real status (never leaves the row stuck on "refreshing"
 * forever) so the claim can be retried instead of permanently wedged. */
export async function runTrendExplanation(seedId: string, symbol: string, name: string): Promise<void> {
  try {
    const result = await explainTrend(symbol, name);
    if (!result) {
      const { error } = await serviceDb()
        .from("trend_explanations")
        .update({ status: "error: Perplexity lookup failed or timed out" })
        .eq("seed_id", seedId);
      if (error) throw new Error(`Failed to save trend_explanations failure: ${error.message}`);
      return;
    }
    const { error } = await serviceDb()
      .from("trend_explanations")
      .update({
        status: "ok",
        reason_summary: result.reasonSummary,
        narrative_tags: result.narrativeTags,
        category_guess: result.categoryGuess,
        ai_tickers: result.aiTickers,
        confidence: result.confidence,
        sources: result.sources,
        computed_at: new Date().toISOString(),
      })
      .eq("seed_id", seedId);
    if (error) throw new Error(`Failed to save trend_explanations: ${error.message}`);
  } catch (e) {
    await serviceDb()
      .from("trend_explanations")
      .update({ status: `error: ${(e as Error).message}` })
      .eq("seed_id", seedId);
  }
}

/** Resolves the AI's raw {ticker, reason} pairs to real CoinGecko coin ids
 * via the same searchCoins()+pickBestMatch() pair Watchlist's bulk-add
 * already trusts for exactly this "a bare ticker string might not be what
 * it looks like" problem — a ticker that doesn't resolve confidently is
 * dropped, never guessed at. One /search call per ticker (no batch
 * endpoint), so this is bounded by how many tickers the AI actually names
 * (typically a handful), not a concern at this scale. Returns id -> reason
 * so page.tsx can show each AI-suggested row's own specific justification
 * (see AiPeerTicker's own doc comment) rather than just the list. */
async function resolveAiTickers(tickers: AiPeerTicker[]): Promise<Map<string, string>> {
  const reasonsById = new Map<string, string>();
  for (const { ticker, reason } of tickers) {
    const results = await searchCoins(ticker);
    const match = pickBestMatch(ticker, results);
    if (match && !reasonsById.has(match.id)) reasonsById.set(match.id, reason);
  }
  return reasonsById;
}

export type TrendPeersResult =
  | { status: "no-seed-data"; seedId: string }
  | {
      status: "ok";
      seed: SeedInfo;
      explanation: TrendExplanationRow;
      category: CategoryStat | null;
      categoryPeers: PeerRow[];
      aiPeers: PeerRow[];
      /** id -> the AI's specific reason for naming that peer — keyed
       * separately from aiPeers since PeerRow is shared with the category
       * table (which has no per-row reason). */
      aiPeerReasons: Map<string, string>;
    };

/**
 * The Trend Finder orchestrator: reads a stored, web-search-grounded AI
 * explanation of why the seed is moving and what else is moving for a
 * similar reason, cross-referenced against CoinGecko's own category
 * taxonomy — replaces v2's price-correlation approach entirely (see
 * trendFinder.ts's doc comment for why: real recent rotations and
 * narrative-driven moves this session checked against aren't present in
 * price history at any lag, only in news). Own file rather than
 * queries.ts, matching how lookup.ts owns the lookup page's orchestration.
 *
 * The AI explanation itself is never fetched live here — `explanation`
 * is always just a read of whatever's cached (possibly nothing yet). The
 * live Perplexity call only ever happens via the explicit Refresh action
 * (see runTrendExplanation) — this function stays fast and side-effect-
 * free on every page load, unlike its old TTL-recompute design. Category/
 * AI-suggested peer market data is still fetched live from CoinGecko on
 * every call — that's fast, free-tier-respecting, and unrelated to the
 * "research shouldn't be redone" concern, which is specifically about the
 * slow, costed Perplexity narrative call.
 */
export async function findTrendPeers({
  coingeckoId,
  mcapFloor,
}: {
  coingeckoId: string;
  mcapFloor: number;
}): Promise<TrendPeersResult> {
  const seed = await fetchSeedInfo(coingeckoId);
  if (!seed) return { status: "no-seed-data", seedId: coingeckoId };

  const explanation = await getTrendExplanation(coingeckoId);
  const data = explanation.data;

  const [categoryStats, aiPeerReasons] = await Promise.all([
    data?.categoryGuess ? fetchCategoryStats() : Promise.resolve<CategoryStat[]>([]),
    data ? resolveAiTickers(data.aiTickers) : Promise.resolve(new Map<string, string>()),
  ]);

  const category = data?.categoryGuess ? matchCategoryName(data.categoryGuess, categoryStats) : null;

  const [categoryMembers, aiPeerInfo] = await Promise.all([
    category ? fetchCategoryMembers(category.id) : Promise.resolve<PeerRow[]>([]),
    fetchMarketsByIds([...aiPeerReasons.keys()]),
  ]);

  const categoryPeers = rankPeers(categoryMembers, { seedId: coingeckoId, mcapFloor });
  const aiPeers = rankPeers(aiPeerInfo, { seedId: coingeckoId, mcapFloor });

  return { status: "ok", seed, explanation, category, categoryPeers, aiPeers, aiPeerReasons };
}

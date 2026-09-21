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

// News moves roughly daily — re-paying ~$0.015 on every page load for the
// same seed is wasteful, not "more live." Matches coin_categories'/coin_
// correlations' own TTL-cache shape before it.
const EXPLANATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedExplanation {
  reasonSummary: string;
  narrativeTags: string[];
  categoryGuess: string | null;
  aiTickers: AiPeerTicker[];
  confidence: "high" | "medium" | "low";
  sources: { title: string; url: string }[];
}

/** Lazy-populate-on-read cache for one seed's AI trend explanation — same
 * shape as coin_categories'/coin_correlations' own TTL cache before it. */
async function getCachedExplanation(seedId: string): Promise<CachedExplanation | null> {
  const { data, error } = await serviceDb()
    .from("trend_explanations")
    .select("reason_summary, narrative_tags, category_guess, ai_tickers, confidence, sources, computed_at")
    .eq("seed_id", seedId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load trend_explanations: ${error.message}`);
  if (!data) return null;

  const row = data as {
    reason_summary: string;
    narrative_tags: string[];
    category_guess: string | null;
    ai_tickers: AiPeerTicker[];
    confidence: "high" | "medium" | "low";
    sources: { title: string; url: string }[];
    computed_at: string;
  };
  const isFresh = Date.now() - new Date(row.computed_at).getTime() < EXPLANATION_CACHE_TTL_MS;
  if (!isFresh) return null;
  return {
    reasonSummary: row.reason_summary,
    narrativeTags: row.narrative_tags,
    categoryGuess: row.category_guess,
    aiTickers: row.ai_tickers,
    confidence: row.confidence,
    sources: row.sources,
  };
}

async function cacheExplanation(seedId: string, explanation: TrendExplanation): Promise<void> {
  const { error } = await serviceDb()
    .from("trend_explanations")
    .upsert(
      {
        seed_id: seedId,
        reason_summary: explanation.reasonSummary,
        narrative_tags: explanation.narrativeTags,
        category_guess: explanation.categoryGuess,
        ai_tickers: explanation.aiTickers,
        confidence: explanation.confidence,
        sources: explanation.sources,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "seed_id" },
    );
  if (error) throw new Error(`Failed to cache trend_explanations: ${error.message}`);
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
      explanation: TrendExplanation | null;
      category: CategoryStat | null;
      categoryPeers: PeerRow[];
      aiPeers: PeerRow[];
      /** id -> the AI's specific reason for naming that peer — keyed
       * separately from aiPeers since PeerRow is shared with the category
       * table (which has no per-row reason). */
      aiPeerReasons: Map<string, string>;
    };

/**
 * The Trend Finder orchestrator: asks a live, web-search-grounded AI why
 * the seed is moving and what else is moving for a similar reason, cross-
 * referenced against CoinGecko's own category taxonomy — replaces v2's
 * price-correlation approach entirely (see trendFinder.ts's doc comment
 * for why: real recent rotations and narrative-driven moves this session
 * checked against aren't present in price history at any lag, only in
 * news). Own file rather than queries.ts, matching how lookup.ts owns the
 * lookup page's orchestration.
 *
 * `explanation: null` (the AI call failed/timed out, or the cache is
 * simply empty and the call errors) still returns category peers if a
 * category match was found — degrade, don't blank-page. Ticker/category
 * peer lists are independent: either, both, or neither may be non-empty.
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

  const cached = await getCachedExplanation(coingeckoId);
  let explanation: TrendExplanation | null;
  if (cached) {
    explanation = cached;
  } else {
    explanation = await explainTrend(seed.symbol, seed.name);
    if (explanation) await cacheExplanation(coingeckoId, explanation);
  }

  const [categoryStats, aiPeerReasons] = await Promise.all([
    explanation?.categoryGuess ? fetchCategoryStats() : Promise.resolve<CategoryStat[]>([]),
    explanation ? resolveAiTickers(explanation.aiTickers) : Promise.resolve(new Map<string, string>()),
  ]);

  const category = explanation?.categoryGuess ? matchCategoryName(explanation.categoryGuess, categoryStats) : null;

  const [categoryMembers, aiPeerInfo] = await Promise.all([
    category ? fetchCategoryMembers(category.id) : Promise.resolve<PeerRow[]>([]),
    fetchMarketsByIds([...aiPeerReasons.keys()]),
  ]);

  const categoryPeers = rankPeers(categoryMembers, { seedId: coingeckoId, mcapFloor });
  const aiPeers = rankPeers(aiPeerInfo, { seedId: coingeckoId, mcapFloor });

  return { status: "ok", seed, explanation, category, categoryPeers, aiPeers, aiPeerReasons };
}

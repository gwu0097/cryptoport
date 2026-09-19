import "server-only";
import {
  fetchCoinCategories,
  fetchCategoryStats,
  fetchCategoryMembers,
  fetchSeedInfo,
  type SeedInfo,
  type CategoryStat,
} from "./adapters/coingecko";
import { rankCategories, rankPeers, type RankedCategory, type PeerRow } from "./trendFinder";
import { serviceDb } from "./supabase";

const CATEGORY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — see coin_categories' own doc comment in schema.sql
const MAX_TIERS = 3; // DOGE's narrowest tier returned zero peers above the floor — walking is required, but bounded
const MIN_PEERS_TARGET = 5;

/** Lazy-populate-on-read cache for a coin's own category names — same
 * precedent as resolveTickerIcons in coingecko.ts, but with a TTL (a stale
 * category list silently changes which peers get shown, unlike a cosmetic
 * icon that's fetched once forever). */
async function getCoinCategories(coingeckoId: string): Promise<string[]> {
  const { data, error } = await serviceDb()
    .from("coin_categories")
    .select("categories, updated_at")
    .eq("coingecko_id", coingeckoId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load coin_categories: ${error.message}`);

  const row = data as { categories: string[]; updated_at: string } | null;
  const isFresh = row && Date.now() - new Date(row.updated_at).getTime() < CATEGORY_CACHE_TTL_MS;
  if (isFresh) return row.categories;

  const categories = await fetchCoinCategories(coingeckoId);
  const { error: upsertError } = await serviceDb()
    .from("coin_categories")
    .upsert({ coingecko_id: coingeckoId, categories, updated_at: new Date().toISOString() }, { onConflict: "coingecko_id" });
  if (upsertError) throw new Error(`Failed to cache coin_categories: ${upsertError.message}`);
  return categories;
}

export interface TrendTier {
  category: RankedCategory;
  peers: PeerRow[];
}

export type TrendPeersResult =
  | { status: "no-seed-data"; seedId: string }
  | { status: "no-categories"; seed: SeedInfo }
  | { status: "ok"; seed: SeedInfo; tiers: TrendTier[] };

/**
 * The Trend Finder orchestrator: given a seed CoinGecko id, ranks its own
 * categories narrowest-first (see trendFinder.ts) and walks down that list
 * fetching real category members until MIN_PEERS_TARGET peers (above the
 * floor) are found or MAX_TIERS is reached — a fixed "top 2 tiers" was
 * wrong in practice (DOGE's narrowest tier had zero members above a $200M
 * floor). Own file rather than queries.ts, matching how lookup.ts owns the
 * lookup page's orchestration.
 */
export async function findTrendPeers({
  coingeckoId,
  mcapFloor,
}: {
  coingeckoId: string;
  mcapFloor: number;
}): Promise<TrendPeersResult> {
  const [seed, categoryNames, categoryStats] = await Promise.all([
    fetchSeedInfo(coingeckoId),
    getCoinCategories(coingeckoId),
    fetchCategoryStats(),
  ]);

  if (!seed) return { status: "no-seed-data", seedId: coingeckoId };

  // CategoryStat's shape already matches trendFinder.ts's CategoryCap
  // exactly — no remapping needed, just the name-keyed join rankCategories
  // expects.
  const capsByName = new Map<string, CategoryStat>(categoryStats.map((c) => [c.name, c]));
  const ranked = rankCategories(categoryNames, capsByName);
  if (ranked.length === 0) return { status: "no-categories", seed };

  const tiers: TrendTier[] = [];
  let totalPeers = 0;
  for (const category of ranked.slice(0, MAX_TIERS)) {
    const members = await fetchCategoryMembers(category.id);
    const peers = rankPeers(members, { seedId: coingeckoId, mcapFloor });
    tiers.push({ category, peers });
    totalPeers += peers.length;
    if (totalPeers >= MIN_PEERS_TARGET) break;
  }

  return { status: "ok", seed, tiers };
}

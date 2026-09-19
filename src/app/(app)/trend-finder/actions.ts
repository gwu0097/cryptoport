"use server";

import { searchCoins, type CoinSearchResult } from "@/lib/adapters/coingecko";

/**
 * A third near-identical copy of watchlist/actions.ts's searchCoinsAction
 * and wallets/actions.ts's own — normally this repo's threshold for
 * extracting a shared helper. Kept separate deliberately: this one must
 * NOT call requireUser(). Trend Finder shows public, non-personal market
 * data (like the Dashboard's Coin360 heatmap, which CLAUDE.md says renders
 * for everyone regardless of auth) — a signed-out visitor can pick a seed
 * and see peers same as a signed-in one. If that reasoning ever stops
 * holding, unify the three.
 */
export async function searchCoinsAction(query: string): Promise<CoinSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  return searchCoins(trimmed);
}

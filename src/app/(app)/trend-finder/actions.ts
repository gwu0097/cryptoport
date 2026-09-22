"use server";

import { after } from "next/server";
import { searchCoins, type CoinSearchResult } from "@/lib/adapters/coingecko";
import {
  getTrendExplanation,
  claimTrendExplanation,
  runTrendExplanation,
  type TrendExplanationRow,
} from "@/lib/trendPeers";
import type { JobStartResult } from "@/lib/jobStatus";

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

/** Read-only — the client refresh island (TrendExplanationRefresh.tsx)
 * polls this directly while a scan is in flight, same shape as
 * watchlist/actions.ts's getTokenAnalysisAction. Not gated behind
 * requireUser() — see searchCoinsAction's own doc comment above for why
 * Trend Finder stays public. */
export async function getTrendExplanationAction(seedId: string): Promise<TrendExplanationRow> {
  return getTrendExplanation(seedId);
}

/**
 * On-demand only — a previously-scanned token's explanation is now reused
 * forever (see trendPeers.ts's own doc comment on findTrendPeers); this is
 * the only thing that ever triggers a fresh Perplexity call. Same CAS-
 * claim + after() shape as watchlist/actions.ts's refreshTokenAnalysis, so
 * this doesn't freeze the app's shared navigation queue the way an awaited
 * ~20-30s action would (CLAUDE.md's Loading Feedback section).
 */
export async function refreshTrendExplanation(seedId: string, symbol: string, name: string): Promise<JobStartResult> {
  const claimed = await claimTrendExplanation(seedId);
  if (!claimed) return { started: false, reason: "A scan is already running for this token." };

  after(async () => {
    await runTrendExplanation(seedId, symbol, name);
  });

  return { started: true };
}

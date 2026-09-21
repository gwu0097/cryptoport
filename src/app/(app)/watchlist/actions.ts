"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { userDb } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { searchCoins, type CoinSearchResult } from "@/lib/adapters/coingecko";
import { refreshCoinsById } from "@/lib/coinMarketData";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { pickBestMatch, MAX_BULK_TICKERS } from "@/lib/watchlistInput";
import { getTokenAnalysis, claimTokenAnalysis, runTokenAnalysis, type TokenAnalysisRow } from "@/lib/tokenAnalysis";
import type { JobStartResult } from "@/lib/jobStatus";

// FormData-based, matching wallets/actions.ts's createWallet/updateWallet
// convention — these are submitted from a real <form>, unlike
// addWatchlistItem/addWatchlistItems below (which pass a structured object
// a form can't produce, so those are called directly as functions instead).
function requireName(formData: FormData): string {
  const value = formData.get("name");
  if (typeof value !== "string" || value.trim() === "") throw new Error("A watchlist needs a name.");
  return value.trim();
}

export async function createWatchlist(formData: FormData) {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db
    .from("watchlists")
    .insert({ name: requireName(formData) })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create watchlist: ${error.message}`);

  revalidatePath("/watchlist");
  redirect(`/watchlist?list=${data.id}`);
}

export async function renameWatchlist(watchlistId: string, formData: FormData) {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watchlists").update({ name: requireName(formData) }).eq("id", watchlistId);
  if (error) throw new Error(`Failed to rename watchlist: ${error.message}`);
  revalidatePath("/watchlist");
}

/** Copies a list's name (suffixed) and every item row into a brand-new
 * watchlist — two independent rows sharing no state afterward, so removing
 * a coin from the clone never touches the original. Item copies carry over
 * the identity fields captured at the original's own add-time
 * (coingecko_id/ticker/name/image_url); coin_market_data is shared/global
 * and already covers whatever's copied, so there's nothing to duplicate
 * there. */
export async function cloneWatchlist(watchlistId: string) {
  await requireUser();
  const db = await userDb();

  const { data: source, error: sourceError } = await db
    .from("watchlists")
    .select("name")
    .eq("id", watchlistId)
    .single();
  if (sourceError) throw new Error(`Failed to load watchlist: ${sourceError.message}`);

  const { data: items, error: itemsError } = await db
    .from("watchlist_items")
    .select("coingecko_id, ticker, name, image_url")
    .eq("watchlist_id", watchlistId);
  if (itemsError) throw new Error(`Failed to load watchlist items: ${itemsError.message}`);

  const { data: clone, error: cloneError } = await db
    .from("watchlists")
    .insert({ name: `${source.name} (copy)` })
    .select("id")
    .single();
  if (cloneError) throw new Error(`Failed to clone watchlist: ${cloneError.message}`);

  if (items.length > 0) {
    const { error: insertError } = await db
      .from("watchlist_items")
      .insert(items.map((item) => ({ ...item, watchlist_id: clone.id })));
    if (insertError) throw new Error(`Failed to copy watchlist items: ${insertError.message}`);
  }

  revalidatePath("/watchlist");
  redirect(`/watchlist?list=${clone.id}`);
}

export async function deleteWatchlist(watchlistId: string) {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watchlists").delete().eq("id", watchlistId);
  if (error) throw new Error(`Failed to delete watchlist: ${error.message}`);

  revalidatePath("/watchlist");
  redirect("/watchlist");
}

export interface AddableCoin {
  coingeckoId: string;
  ticker: string;
  name: string;
  imageUrl: string | null;
}

async function insertItems(watchlistId: string, coins: AddableCoin[]): Promise<void> {
  if (coins.length === 0) return;
  const db = await userDb();
  const { error } = await db
    .from("watchlist_items")
    .upsert(
      coins.map((c) => ({
        watchlist_id: watchlistId,
        coingecko_id: c.coingeckoId,
        ticker: c.ticker,
        name: c.name,
        image_url: c.imageUrl,
      })),
      { onConflict: "watchlist_id,coingecko_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Failed to add to watchlist: ${error.message}`);
}

/** Awaits the new coin's real market data directly rather than doing it
 * inside after() — reported directly, with a screenshot: a freshly-added
 * coin (VIRTUAL) kept showing "—" across every column indefinitely, not
 * just until the next refresh. Root cause was CLAUDE.md's own documented
 * after()/revalidatePath gap (see the Caching section): the response this
 * action's own click was waiting on had already gone out by the time
 * after() ran refreshCoinsById + revalidatePath, so that revalidation
 * could purge the *server's* cache but could never reach *this* browser
 * tab — the watchlist page stayed on its pre-fetch render (no price yet)
 * until an unrelated full navigation happened to refetch it. after() is
 * for multi-second work that would otherwise freeze the whole app's
 * navigation queue (chain scans, wallet syncs); a single /coins/markets
 * call for up to MAX_BULK_TICKERS ids (one batch — see coingecko.ts's
 * MARKETS_BATCH_SIZE=250) is fast enough to just await like any other
 * quick mutation, and doing so is what lets the one real revalidatePath
 * call (after the write, not before) actually show the fetched price on
 * first render instead of racing it. */
export async function addWatchlistItem(watchlistId: string, coin: AddableCoin) {
  await requireUser();
  await insertItems(watchlistId, [coin]);
  await refreshCoinsById([coin.coingeckoId]).catch(() => {
    // Best-effort — the item is already saved; it just shows "—" until
    // the next successful refresh instead of a fabricated number.
  });
  revalidatePath("/watchlist");
}

export async function addWatchlistItems(watchlistId: string, coins: AddableCoin[]) {
  await requireUser();
  await insertItems(watchlistId, coins);
  await refreshCoinsById(coins.map((c) => c.coingeckoId)).catch(() => {
    // Best-effort — see addWatchlistItem's own comment.
  });
  revalidatePath("/watchlist");
}

export async function removeWatchlistItem(itemId: string) {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watchlist_items").delete().eq("id", itemId);
  if (error) throw new Error(`Failed to remove watchlist item: ${error.message}`);
  revalidatePath("/watchlist");
}

/** Thin wrapper the client calls (debounced) for live add-by-search
 * suggestions. Sign-in gated like every other watchlist action even though
 * it's read-only — CoinGecko's /search is free, but there's no reason to
 * let a guest fire calls against it through this app. */
export async function searchCoinsAction(query: string): Promise<CoinSearchResult[]> {
  await requireUser();
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  return searchCoins(trimmed);
}

export interface TickerMatch {
  ticker: string;
  match: CoinSearchResult | null;
}

/** Bulk-add's resolve step — no writes. Each typed ticker gets matched
 * against a live CoinGecko search (see pickBestMatch's own doc comment for
 * the exact-symbol-first rule), concurrency-capped like every other
 * external-API fan-out in this app (mapWithConcurrency, see adapters/
 * http.ts). Caps defensively at MAX_BULK_TICKERS even though the client
 * already caps the pasted input via parseTickerInput, since this can be
 * called directly. */
export async function resolveTickersAction(rawTickers: string[]): Promise<TickerMatch[]> {
  await requireUser();
  const tickers = rawTickers.slice(0, MAX_BULK_TICKERS);

  return mapWithConcurrency(tickers, 2, async (ticker) => {
    const results = await searchCoins(ticker);
    return { ticker, match: pickBestMatch(ticker, results) };
  });
}

/** Read-only — the client's own polling loop calls this directly (see
 * TokenAnalysisPanel.tsx) to pick up a refresh's real completion, since
 * this table isn't part of the shared JobPollerProvider's fixed resource
 * set (wallets + price refresh + token registry) — a token's analysis is
 * an unbounded, per-row resource that provider was never built to track.
 * Gated behind requireUser() the same as every other watchlist action,
 * even though it's a read, since the underlying table has no direct RLS
 * client access (serviceDb() bypasses RLS — this check is the real gate). */
export async function getTokenAnalysisAction(coingeckoId: string): Promise<TokenAnalysisRow | null> {
  await requireUser();
  return getTokenAnalysis(coingeckoId);
}

/**
 * On-demand only — never run automatically, per the direct ask ("I'll
 * decide when I want it run"). Same CAS-claim/after() shape as
 * syncWalletHoldings/syncWalletDefi (wallets/actions.ts): claim returns
 * almost immediately, the real ~20-30s Perplexity call happens in after()
 * so this doesn't freeze the app's shared navigation queue the way an
 * awaited slow Server Action would (see CLAUDE.md's Loading Feedback
 * section — backfillHistoryAction hit exactly this bug once, this follows
 * the fix from day one instead of needing the same fix twice).
 */
export async function refreshTokenAnalysis(coingeckoId: string, ticker: string, name: string): Promise<JobStartResult> {
  await requireUser();
  const claimed = await claimTokenAnalysis(coingeckoId);
  if (!claimed) return { started: false, reason: "An analysis is already running for this token." };

  after(async () => {
    await runTokenAnalysis(coingeckoId, ticker, name);
  });

  return { started: true };
}

import "server-only";
import { cache } from "react";
import { serviceDb } from "../supabase";
import { fetchCategoryList, fetchAllCategoryMembers } from "./coingecko";
import { categoryBase, type LiquidStakingToken } from "../liquidStaking";

// cryptoport.liquid_staking_tokens: every member of CoinGecko's liquid
// staking categories — what the Assets page's "Combine liquid staking
// tokens" view (liquidStaking.ts) folds into base coins. Slow-changing
// shared reference data (CLAUDE.md caching rule 2): refreshed with the token
// list (lib/tokenRegistryRefresh.ts — weekly cron, or after a sync meets an
// unknown Solana/Sui token), never on a page load.

/** CoinGecko's liquid staking/restaking token categories, by name: the
 * coin-specific ones ("Liquid Staked ETH", "Liquid Restaked SOL") and the
 * generic ones ("Liquid Staking Tokens", "Liquid Restaking Tokens"). Not
 * the governance-token ones (LDO, ETHFI are the protocols' own coins). */
export function isLiquidStakingCategory(name: string): boolean {
  return categoryBase(name) !== null || /^Liquid (Re)?staking Tokens$/i.test(name.trim());
}

/** ~10 CoinGecko calls (one list + one per category, paged). Replaces the
 * table's contents with this run's members. */
export async function refreshLiquidStakingTokens(): Promise<{ tokens: number; categories: number }> {
  const categories = (await fetchCategoryList()).filter((c) => isLiquidStakingCategory(c.name));
  if (categories.length === 0) throw new Error("CoinGecko returned no liquid staking categories");

  const rows = new Map<string, { coingecko_id: string; symbol: string; base_symbol: string | null; categories: string[] }>();
  for (const c of categories) {
    const base = categoryBase(c.name);
    for (const m of await fetchAllCategoryMembers(c.id)) {
      const row = rows.get(m.id) ?? { coingecko_id: m.id, symbol: m.symbol, base_symbol: null, categories: [] };
      row.categories.push(c.id);
      // Two coin-specific categories disagreeing on the base: keep neither.
      if (base) row.base_symbol = row.base_symbol === null || row.base_symbol === base ? base : "";
      rows.set(m.id, row);
    }
  }
  const startedAt = new Date().toISOString();
  const payload = [...rows.values()].map((r) => ({ ...r, base_symbol: r.base_symbol || null, updated_at: startedAt }));

  const db = serviceDb();
  const { error } = await db.from("liquid_staking_tokens").upsert(payload, { onConflict: "coingecko_id" });
  if (error) throw new Error(`Failed to save liquid staking tokens: ${error.message}`);
  // Tokens CoinGecko no longer lists in any of these categories.
  const { error: pruneError } = await db.from("liquid_staking_tokens").delete().lt("updated_at", startedAt);
  if (pruneError) throw new Error(`Failed to prune liquid staking tokens: ${pruneError.message}`);
  return { tokens: payload.length, categories: categories.length };
}


/** The whole table (a few hundred rows), deduped per request. Empty on a
 * read failure: the Assets page then just shows tokens uncombined. */
export const getLiquidStakingTokens = cache(async (): Promise<LiquidStakingToken[]> => {
  const { data, error } = await serviceDb().from("liquid_staking_tokens").select("coingecko_id, symbol, base_symbol");
  if (error) {
    console.warn(`[liquidStaking] read failed: ${error.message}`);
    return [];
  }
  return (data as { coingecko_id: string; symbol: string; base_symbol: string | null }[]).map((r) => ({
    coingeckoId: r.coingecko_id,
    symbol: r.symbol,
    baseSymbol: r.base_symbol,
  }));
});

import "server-only";
import { serviceDb } from "./supabase";
import { fetchMarketStatsByIds } from "./adapters/coingecko";

/**
 * Writer for cryptoport.coin_market_data — shared, coingecko-id-keyed
 * market data (price + 1h/24h/7d/30d change + market cap) for Watchlist
 * items. Deliberately separate from prices.ts's ticker-keyed pipeline: a
 * ticker-keyed table can't safely hold watchlist data (CoinGecko returns
 * 20+ distinct coins for a symbol like "PEPE" alone — pricing by ticker
 * would silently mix one coin's price onto another's row, the same class
 * of bug CLAUDE.md's valuation.ts "KNOWN GAP" comment already documents
 * for Solana holdings). Keying by coingecko_id sidesteps that collision
 * class entirely rather than inheriting it.
 */
export async function refreshCoinsById(coingeckoIds: string[]): Promise<{ coins: number }> {
  if (coingeckoIds.length === 0) return { coins: 0 };

  const stats = await fetchMarketStatsByIds(coingeckoIds);
  if (stats.size === 0) return { coins: 0 };

  const rows = [...stats.entries()].map(([coingeckoId, s]) => ({
    coingecko_id: coingeckoId,
    price_usd: s.usd,
    change_1h: s.change1h,
    change_24h: s.change24h,
    change_7d: s.change7d,
    change_30d: s.change30d,
    market_cap: s.marketCap,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await serviceDb().from("coin_market_data").upsert(rows, { onConflict: "coingecko_id" });
  if (error) throw new Error(`Failed to save coin market data: ${error.message}`);

  return { coins: rows.length };
}

/**
 * Every distinct coin any user is watching, across all users — same
 * cross-user shape as prices.ts's getDistinctHoldingTickers, since pricing
 * is a shared/global concern regardless of who added the coin.
 */
async function getDistinctWatchedCoinIds(): Promise<string[]> {
  const { data, error } = await serviceDb().from("watchlist_items").select("coingecko_id");
  if (error) throw new Error(`Failed to load watchlist coin ids: ${error.message}`);
  return [...new Set((data ?? []).map((r) => r.coingecko_id as string))];
}

/** Called alongside (never chained after — see runPriceRefresh) the
 * existing holdings-driven refreshPrices() so one "Refresh prices" button
 * keeps every price on the same standardized CoinGecko path. */
export async function refreshWatchlistMarketData(): Promise<{ coins: number }> {
  const ids = await getDistinctWatchedCoinIds();
  return refreshCoinsById(ids);
}

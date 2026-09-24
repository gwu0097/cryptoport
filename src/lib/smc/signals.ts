import "server-only";
import { userDb } from "@/lib/supabase";
import { getUser } from "@/lib/auth";
import type { IndicatorId } from "@/lib/signals/rules";
import type { ChartTimeframe } from "./engine";
import { computeWatchlistRows, type WatchlistSignalRow } from "./signalData";

export { getIndicatorChart, perpNameFor, computeWatchlistRows, type IndicatorChartData, type WatchlistSignalRow } from "./signalData";

/** One indicator's signal state for the tokens in one of the signed-in user's
 * watchlists (or all of them, deduped by ticker), at one timeframe. null = signed out.
 * Deliberately reads only tickers (no market-data merge), so this page makes
 * no CoinGecko calls. `watchlistId` must already be validated as the user's
 * (RLS would return nothing for anyone else's anyway). */
export async function getWatchlistSignals(
  ind: IndicatorId,
  tf: ChartTimeframe,
  watchlistId?: string,
): Promise<{ rows: WatchlistSignalRow[]; computedAt: string; retryAtSec: number | null } | null> {
  if (!(await getUser())) return null;
  const db = await userDb();
  const query = db.from("watchlist_items").select("ticker, name, image_url");
  const { data, error } = await (watchlistId ? query.eq("watchlist_id", watchlistId) : query);
  if (error) throw new Error(`Failed to load watchlist items: ${error.message}`);
  const seen = new Set<string>();
  const items = (data as { ticker: string; name: string; image_url: string | null }[]).filter((i) => {
    const k = i.ticker.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return computeWatchlistRows(ind, tf, items);
}


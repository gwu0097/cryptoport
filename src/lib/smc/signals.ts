import "server-only";
import { userDb } from "@/lib/supabase";
import { getUser } from "@/lib/auth";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { computeSmc, TIMEFRAMES, type ChartTimeframe, type Candle, type SmcResult } from "./engine";
import { fetchCandles, fetchPerpNames } from "./hyperliquid";

const DAY_MS = 86_400_000;

export interface SmcChartData {
  coin: string;
  tf: ChartTimeframe;
  candles: Candle[];
  result: SmcResult;
  computedAt: string;
}

export async function getSmcChart(coin: string, tf: ChartTimeframe): Promise<SmcChartData> {
  const now = Date.now();
  const candles = await fetchCandles(coin, TIMEFRAMES[tf].interval, now - TIMEFRAMES[tf].historyDays * DAY_MS, now);
  return { coin, tf, candles, result: computeSmc(candles, tf, Math.floor(now / 1000)), computedAt: new Date(now).toISOString() };
}

/** A watchlist ticker's Hyperliquid perp name: the same symbol, or the
 * k-prefixed 1,000x contract for low-priced tokens (kPEPE, kBONK — prices
 * and trigger levels are then per 1,000 tokens). null = not listed. */
export function perpNameFor(ticker: string, perps: ReadonlySet<string>): string | null {
  const t = ticker.toUpperCase();
  if (perps.has(t)) return t;
  if (perps.has(`k${t}`)) return `k${t}`;
  return null;
}

export interface WatchlistSignalRow {
  ticker: string;
  name: string;
  coin: string | null; // Hyperliquid perp name; null = not listed there
  bull: boolean | null;
  lastFlipSide: "BUY" | "SELL" | null;
  lastFlipTime: number | null;
  lastPrice: number | null;
  triggerPrice: number | null;
  triggerFlipTo: "BUY" | "SELL" | null;
  triggerDecidedAt: number | null; // when the forming block closes
  error: string | null;
}

/** Signal state for every token across the signed-in user's watchlists, at
 * one timeframe. null = signed out. Deliberately reads only tickers (no
 * market-data merge), so this page makes no CoinGecko calls. */
export async function getWatchlistSignals(tf: ChartTimeframe): Promise<WatchlistSignalRow[] | null> {
  if (!(await getUser())) return null;
  const db = await userDb();
  const { data, error } = await db.from("watchlist_items").select("ticker, name");
  if (error) throw new Error(`Failed to load watchlist items: ${error.message}`);
  const seen = new Set<string>();
  const items = (data as { ticker: string; name: string }[]).filter((i) => {
    const k = i.ticker.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const perps = new Set(await fetchPerpNames());

  return mapWithConcurrency(items, 4, async (item): Promise<WatchlistSignalRow> => {
    const coin = perpNameFor(item.ticker, perps);
    const empty = { ticker: item.ticker.toUpperCase(), name: item.name, coin, bull: null, lastFlipSide: null, lastFlipTime: null, lastPrice: null, triggerPrice: null, triggerFlipTo: null, triggerDecidedAt: null };
    if (!coin) return { ...empty, error: null };
    try {
      const { candles, result } = await getSmcChart(coin, tf);
      return {
        ...empty,
        bull: result.state?.bull ?? null,
        lastFlipSide: result.state?.lastFlip?.side ?? null,
        lastFlipTime: result.state?.lastFlip?.time ?? null,
        lastPrice: candles.at(-1)?.c ?? null,
        triggerPrice: result.trigger?.price ?? null,
        triggerFlipTo: result.trigger?.flipTo ?? null,
        triggerDecidedAt: result.trigger?.formingBlockEnd ?? null,
        error: null,
      };
    } catch (e) {
      return { ...empty, error: (e as Error).message };
    }
  });
}

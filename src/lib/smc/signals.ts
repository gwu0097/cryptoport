import "server-only";
import { userDb } from "@/lib/supabase";
import { getUser } from "@/lib/auth";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { formatPrice } from "@/lib/format";
import { viewFor, type IndicatorView, type SignalMark } from "@/lib/signals/view";
import type { IndicatorId } from "@/lib/signals/rules";
import type { NextTrigger } from "@/lib/signals/triggers";
import { TIMEFRAMES, BLOCK_MULTIPLIER, type ChartTimeframe, type Candle } from "./engine";
import { fetchCandles, fetchPerpNames } from "./hyperliquid";

const DAY_MS = 86_400_000;

export interface IndicatorChartData {
  coin: string;
  tf: ChartTimeframe;
  candles: Candle[];
  view: IndicatorView;
  computedAt: string;
}

// The watchlist table only needs each token's CURRENT state, not a chart's
// worth of history. SMC: RMA(8) forgets its seed at (7/8)^n, so 150 blocks
// leaves ~1e-9 of it. The bar-close indicators: SMA(200) + ~400 bars of
// position history (EMA(50)'s seed is gone long before). ~450-600 candles per
// token instead of up to ~2,400 (4H chart history): fetching full chart
// history for every watchlist token tripped Hyperliquid's per-minute
// request-weight limit (HTTP 429) on the first 4H load in prod.
const STATE_BLOCKS = 150;
const STATE_BARS = 600;

function stateLookbackMs(ind: IndicatorId, tf: ChartTimeframe): number {
  const bars = ind === "smc" ? STATE_BLOCKS * BLOCK_MULTIPLIER : STATE_BARS;
  return bars * TIMEFRAMES[tf].candleSeconds * 1000;
}

async function computeFor(ind: IndicatorId, coin: string, tf: ChartTimeframe, lookbackMs: number): Promise<IndicatorChartData> {
  const now = Date.now();
  const candles = await fetchCandles(coin, TIMEFRAMES[tf].interval, now - lookbackMs, now);
  const view = viewFor(ind, candles, tf, Math.floor(now / 1000), formatPrice);
  return { coin, tf, candles, view, computedAt: new Date(now).toISOString() };
}

/** Full chart history (one call) for the chart view. */
export async function getIndicatorChart(ind: IndicatorId, coin: string, tf: ChartTimeframe): Promise<IndicatorChartData> {
  return computeFor(ind, coin, tf, TIMEFRAMES[tf].historyDays * DAY_MS);
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
  imageUrl: string | null;
  coin: string | null; // Hyperliquid perp name; null = not listed there
  state: IndicatorView["state"];
  lastSignal: SignalMark | null;
  lastPrice: number | null; // the forming candle's latest close
  trigger: NextTrigger | null;
  decidedAt: number | null; // when the forming bar/block closes
  venueBars: number | null;
  error: string | null;
}

/** One indicator's signal state for the tokens in one of the signed-in user's
 * watchlists (or all of them, deduped by ticker), at one timeframe. null = signed out.
 * Deliberately reads only tickers (no market-data merge), so this page makes
 * no CoinGecko calls. `watchlistId` must already be validated as the user's
 * (RLS would return nothing for anyone else's anyway). */
export async function getWatchlistSignals(
  ind: IndicatorId,
  tf: ChartTimeframe,
  watchlistId?: string,
): Promise<{ rows: WatchlistSignalRow[]; computedAt: string } | null> {
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
  const perps = new Set(await fetchPerpNames());

  const computedAt = new Date().toISOString();
  const rows = await mapWithConcurrency(items, 4, async (item): Promise<WatchlistSignalRow> => {
    const coin = perpNameFor(item.ticker, perps);
    const empty = { ticker: item.ticker.toUpperCase(), name: item.name, imageUrl: item.image_url, coin, state: null, lastSignal: null, lastPrice: null, trigger: null, decidedAt: null, venueBars: null };
    if (!coin) return { ...empty, error: null };
    try {
      const { candles, view } = await computeFor(ind, coin, tf, stateLookbackMs(ind, tf));
      return {
        ...empty,
        state: view.state,
        lastSignal: view.signals.at(-1) ?? null,
        lastPrice: candles.at(-1)?.c ?? null,
        trigger: view.trigger,
        decidedAt: view.decidedAt,
        venueBars: view.venueBars,
        error: null,
      };
    } catch (e) {
      return { ...empty, error: (e as Error).message };
    }
  });
  return { rows, computedAt };
}

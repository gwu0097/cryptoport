import "server-only";
// Hyperliquid-side data for the Signals page: the completed-candle cache,
// the chart, and the per-token watchlist compute. No auth/DB here (that's
// signals.ts), so scripts/diag/signals-weight.ts can drive the real path.
import { mapWithConcurrency } from "@/lib/adapters/http";
import { formatPrice } from "@/lib/format";
import { viewFor, type IndicatorView, type SignalMark } from "@/lib/signals/view";
import type { IndicatorId } from "@/lib/signals/rules";
import type { NextTrigger } from "@/lib/signals/triggers";
import { TIMEFRAMES, BLOCK_MULTIPLIER, type ChartTimeframe, type Candle } from "./engine";
import {
  fetchAllMids,
  fetchCandles,
  fetchPerpNames,
  newMeter,
  requestMeter,
  budgetSpent,
  RateLimitedError,
  type WeightMeter,
} from "./hyperliquid";
import { applyFetch, candlesFrom, planFetch, type CandleEntry, type FetchPlan } from "./candleCache";

const DAY_MS = 86_400_000;

// ---- Completed-candle cache -------------------------------------------------
// Where: this server process's memory. Completed candles never change, so the
// cache is exact (candleCache.ts); it needs no DB table/DDL, no storage, no
// extra round trip; Vercel reuses warm instances, so repeat loads hit it, and
// a cold instance just pays what every load used to. Keyed (coin, interval),
// shared by every indicator (they all read the same candles).
const MAX_ENTRIES = 400;
const store = new Map<string, CandleEntry>();

function remember(key: string, e: CandleEntry) {
  store.delete(key); // Map order = recency, for LRU eviction
  store.set(key, e);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
}

export interface CandleLoad {
  candles: Candle[];
  /** The clock the indicators should run at: now, or when stale data was fetched. */
  asOfSec: number;
  /** Set when a needed fetch was refused by the rate budget and cached data was served instead. */
  stale: { retryAtSec: number } | null;
  plan: FetchPlan["kind"];
}

/** Candles from `wantFromSec` to now for one perp — from the cache when it's
 * still exact, else fetching only what's new. `liveForming`: the chart wants
 * the forming candle's current high/low/close, so it always fetches from the
 * last completed candle (~21 weight) even on a cache hit. */
async function loadCandles(coin: string, tf: ChartTimeframe, wantFromSec: number, meter: WeightMeter, liveForming = false): Promise<CandleLoad> {
  const { interval, candleSeconds } = TIMEFRAMES[tf];
  const key = `${coin}:${interval}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const e = store.get(key);
  let plan = planFetch(e, wantFromSec, nowSec);
  if (plan.kind === "hit" && liveForming) plan = { kind: "incremental", fromSec: e!.completed.at(-1)?.t ?? e!.coverFromSec };
  if (plan.kind === "hit") return { candles: candlesFrom(e!, wantFromSec), asOfSec: nowSec, stale: null, plan: "hit" };
  try {
    const fetched = await fetchCandles(coin, interval, plan.fromSec * 1000, nowSec * 1000, [meter]);
    const next = applyFetch(e, plan, fetched, candleSeconds, nowSec);
    remember(key, next);
    return { candles: candlesFrom(next, wantFromSec), asOfSec: nowSec, stale: null, plan: plan.kind };
  } catch (err) {
    if (!(err instanceof RateLimitedError) || !e || e.coverFromSec > wantFromSec) throw err;
    return { candles: candlesFrom(e, wantFromSec), asOfSec: e.fetchedAtSec, stale: { retryAtSec: Math.ceil(err.retryAtMs / 1000) }, plan: plan.kind };
  }
}

function logLoad(section: string, meter: WeightMeter, extra: Record<string, unknown>) {
  const req = requestMeter();
  console.log(
    `[signals] ${section}: weight ${meter.weight} (${meter.requests} requests) ${JSON.stringify(extra)} | this page load so far: ${req.weight} | this process, last 60s: ${budgetSpent()}`,
  );
}

export interface IndicatorChartData {
  coin: string;
  tf: ChartTimeframe;
  candles: Candle[];
  view: IndicatorView;
  computedAt: string;
  /** Rate-limited: showing candles fetched at `dataAsOfSec`; the next try is allowed at `retryAtSec`. */
  stale: { dataAsOfSec: number; retryAtSec: number } | null;
}

// The watchlist table only needs each token's CURRENT state, not a chart's
// worth of history. SMC: RMA(8) forgets its seed at (7/8)^n, so 150 blocks
// leaves ~1e-9 of it. The bar-close indicators: SMA(200) + ~400 bars of
// position history (EMA(50)'s seed is gone long before). ~450-600 candles per
// token instead of up to ~2,400 (4H chart history).
const STATE_BLOCKS = 150;
const STATE_BARS = 600;

function stateLookbackSec(ind: IndicatorId, tf: ChartTimeframe): number {
  const bars = ind === "smc" ? STATE_BLOCKS * BLOCK_MULTIPLIER : STATE_BARS;
  return bars * TIMEFRAMES[tf].candleSeconds;
}

/** Full chart history for the chart view (cached completed candles + a live forming candle). */
export async function getIndicatorChart(ind: IndicatorId, coin: string, tf: ChartTimeframe): Promise<IndicatorChartData> {
  const meter = newMeter();
  const nowSec = Math.floor(Date.now() / 1000);
  const load = await loadCandles(coin, tf, nowSec - (TIMEFRAMES[tf].historyDays * DAY_MS) / 1000, meter, true);
  const view = viewFor(ind, load.candles, tf, load.asOfSec, formatPrice);
  logLoad(`chart ${ind} ${coin} ${tf}`, meter, { cache: load.plan, stale: load.stale !== null });
  return {
    coin,
    tf,
    candles: load.candles,
    view,
    computedAt: new Date(nowSec * 1000).toISOString(),
    stale: load.stale ? { dataAsOfSec: load.asOfSec, retryAtSec: load.stale.retryAtSec } : null,
  };
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
  lastPrice: number | null; // live mid (allMids); null if that call was rate-limited
  /** Rate-limited: this row is computed from candles fetched at this time (trigger withheld — its bar has closed). */
  staleAsOfSec: number | null;
  trigger: NextTrigger | null;
  decidedAt: number | null; // when the forming bar/block closes
  venueBars: number | null;
  error: string | null;
}

/** The network/compute half of getWatchlistSignals, for already-loaded
 * watchlist items (also used by scripts/diag/signals-weight.ts). */
export async function computeWatchlistRows(
  ind: IndicatorId,
  tf: ChartTimeframe,
  items: { ticker: string; name: string; image_url: string | null }[],
): Promise<{ rows: WatchlistSignalRow[]; computedAt: string; retryAtSec: number | null }> {
  const perps = new Set(await fetchPerpNames());
  const computedAt = new Date().toISOString();
  const nowSec = Math.floor(Date.parse(computedAt) / 1000);
  const meter = newMeter();
  // Live prices for the distance column: ONE call (weight 2) for every coin,
  // not a price per token from its forming candle.
  const mids = await fetchAllMids().catch(() => null);
  let retryAtSec: number | null = null;
  const plans: Record<string, number> = {};
  const rows = await mapWithConcurrency(items, 4, async (item): Promise<WatchlistSignalRow> => {
    const coin = perpNameFor(item.ticker, perps);
    const empty = {
      ticker: item.ticker.toUpperCase(),
      name: item.name,
      imageUrl: item.image_url,
      coin,
      state: null,
      lastSignal: null,
      lastPrice: coin ? (mids?.get(coin) ?? null) : null,
      staleAsOfSec: null,
      trigger: null,
      decidedAt: null,
      venueBars: null,
    };
    if (!coin) return { ...empty, error: null };
    try {
      const load = await loadCandles(coin, tf, nowSec - stateLookbackSec(ind, tf), meter);
      plans[load.plan] = (plans[load.plan] ?? 0) + 1;
      const view = viewFor(ind, load.candles, tf, load.asOfSec, formatPrice);
      if (load.stale) {
        retryAtSec = Math.max(retryAtSec ?? 0, load.stale.retryAtSec);
        // The trigger was for a bar that has since closed — never show it as current.
        return { ...empty, state: view.state, lastSignal: view.signals.at(-1) ?? null, staleAsOfSec: load.asOfSec, venueBars: view.venueBars, error: null };
      }
      return {
        ...empty,
        state: view.state,
        lastSignal: view.signals.at(-1) ?? null,
        trigger: view.trigger,
        decidedAt: view.decidedAt,
        venueBars: view.venueBars,
        error: null,
      };
    } catch (e) {
      if (e instanceof RateLimitedError) {
        retryAtSec = Math.max(retryAtSec ?? 0, Math.ceil(e.retryAtMs / 1000));
        plans.rateLimitedNoCache = (plans.rateLimitedNoCache ?? 0) + 1;
        return { ...empty, error: "rate-limited" };
      }
      return { ...empty, error: (e as Error).message };
    }
  });
  logLoad(`watchlist ${ind} ${tf} (${items.length} tokens)`, meter, { ...plans, allMids: mids !== null });
  return { rows, computedAt, retryAtSec };
}

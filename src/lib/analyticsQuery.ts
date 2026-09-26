import "server-only";
import { getActiveWalletsWithHoldings, getAssetsGroupedByTicker, getAssetStatsMap, getValueHistory } from "./queries";
import { getPriceHistoryMap } from "./priceHistory";
import { requestNowSec } from "./requestClock";
import { attribute, WINDOW_DAYS, type Attribution, type AttributionWindow } from "./analytics/attribution.ts";
import { riskProfile, type RiskProfile } from "./analytics/risk.ts";
import { holdingContext, type HoldingContext } from "./analytics/holdingContext.ts";
import type { Holding } from "./types";

// The Analytics page's one read: the same holdings, prices and snapshots
// Assets and Performance show, run through the pure analytics modules. No
// external call — everything here is already stored.

/** Holdings below this share of the portfolio are summarized, not listed. */
const MIN_LISTED_WEIGHT = 0.001;
/** The benchmark: BTC's daily price history (a CoinGecko coin, backfilled
 * like any held coin's). */
const BENCHMARK_KEY = "bitcoin";

export interface AnalyticsView {
  totalUsd: number;
  /** Holdings whose value is unknown (no price) — left out of every figure. */
  unpricedCount: number;
  attribution: Record<AttributionWindow, Attribution>;
  risk: RiskProfile | null;
  holdings: HoldingContext[];
  smallHoldings: { count: number; usd: number };
}

export async function getAnalytics(): Promise<AnalyticsView> {
  const [{ groups, grand }, stats, snapshots, wallets] = await Promise.all([
    getAssetsGroupedByTicker(),
    getAssetStatsMap(),
    getValueHistory(),
    getActiveWalletsWithHoldings(),
  ]);
  const benchmark = { ticker: "BTC", source: "auto", contract: null, chain: null, coingecko_id: BENCHMARK_KEY, price_key: BENCHMARK_KEY } as Pick<
    Holding,
    "ticker" | "source" | "contract" | "chain" | "coingecko_id" | "price_key"
  >;
  const { history } = await getPriceHistoryMap([...wallets.flatMap((w) => w.holdings), benchmark]);
  const today = new Date(requestNowSec() * 1000).toISOString().slice(0, 10);

  // An asset (a price_key with a price) has a price series; everything else
  // with a value — protocol positions, perp margin, rows priced by their
  // stored value — moves without a price change to attribute.
  const assets = groups.filter((g) => !g.tickerKey.startsWith("ticker:") && g.price !== null && g.total > 0);
  const others = groups.filter((g) => !assets.includes(g) && g.total > 0);
  const positions = { usd: others.reduce((s, g) => s + g.total, 0), tickers: others.map((g) => g.ticker) };

  const attributionInput = assets.map((g) => ({
    key: g.tickerKey,
    ticker: g.ticker,
    valueUsd: g.total,
    change: { "24h": g.change24h, "7d": g.change7d, "30d": g.change30d },
  }));
  const attribution = Object.fromEntries(
    (Object.keys(WINDOW_DAYS) as AttributionWindow[]).map((w) => [w, attribute(w, attributionInput, positions, grand.total, snapshots, today)]),
  ) as Record<AttributionWindow, Attribution>;

  const risk = riskProfile(
    [
      ...assets.map((g) => ({ key: g.tickerKey, ticker: g.ticker, valueUsd: g.total, prices: history.get(g.tickerKey) })),
      ...others.map((g) => ({ key: g.tickerKey, ticker: g.ticker, valueUsd: g.total, prices: undefined })),
    ],
    history.get(BENCHMARK_KEY),
  );
  const riskOf = new Map((risk?.assets ?? []).map((a) => [a.key, a]));

  const listed = assets.filter((g) => g.total >= MIN_LISTED_WEIGHT * grand.total);
  const small = assets.filter((g) => !listed.includes(g));
  const holdings = listed
    .map((g) =>
      holdingContext(
        {
          key: g.tickerKey,
          ticker: g.ticker,
          iconUrl: g.iconUrl,
          valueUsd: g.total,
          price: g.price,
          change7d: g.change7d,
          change30d: g.change30d,
          marketCap: g.marketCap,
          volume24h: stats.get(g.tickerKey)?.volume24h ?? null,
          prices: history.get(g.tickerKey),
          risk: riskOf.get(g.tickerKey) ?? null,
        },
        grand.total,
        today,
      ),
    )
    .sort((a, b) => b.valueUsd - a.valueUsd);

  return {
    totalUsd: grand.total,
    unpricedCount: grand.unpricedCount,
    attribution,
    risk,
    holdings,
    smallHoldings: { count: small.length, usd: small.reduce((s, g) => s + g.total, 0) },
  };
}

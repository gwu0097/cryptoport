import "server-only";
import { getActiveWalletsWithHoldings, getAssetsGroupedByTicker, getAssetStatsMap, getPriceMap, getValueHistory } from "./queries";
import { getPriceHistoryMap } from "./priceHistory";
import { requestNowSec } from "./requestClock";
import { attribute, attributeByWallet, daysBefore, WINDOW_DAYS, type Attribution, type AttributionWindow, type WalletAttribution, type WalletAttributionInput } from "./analytics/attribution.ts";
import { userDb } from "./supabase";
import { parseNumeric, valueHolding } from "./valuation";
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
  /** "Everything else" split by wallet, per window (attributeByWallet). */
  byWallet: Record<AttributionWindow, { wallets: WalletAttribution[]; removedUsd: number }>;
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
  // Per wallet, for "where did everything else come from": each wallet's
  // coins (with the asset's change) and its value held outside a priced coin.
  const prices = await getPriceMap();
  const walletInputs: WalletAttributionInput[] = wallets.map((w) => {
    const assets = new Map<string, { key: string; ticker: string; valueUsd: number; change: Record<AttributionWindow, number | null> }>();
    const positions = { usd: 0, tickers: [] as string[] };
    let live = 0;
    for (const h of w.holdings) {
      const v = valueHolding(h, prices);
      if (v.kind !== "priced") continue;
      live += v.usd;
      const st = h.price_key ? stats.get(h.price_key) : undefined;
      if (h.price_key && st && st.usd !== null && h.usd_override == null) {
        const a = assets.get(h.price_key) ?? { key: h.price_key, ticker: h.ticker, valueUsd: 0, change: { "24h": st.change24h, "7d": st.change7d, "30d": st.change30d } };
        a.valueUsd += v.usd;
        assets.set(h.price_key, a);
      } else {
        positions.usd += v.usd;
        positions.tickers.push(h.ticker);
      }
    }
    return { id: w.id, name: w.name, createdAt: (w as { created_at?: string }).created_at ?? null, liveUsd: live, assets: [...assets.values()], positions };
  });
  const windows = Object.keys(WINDOW_DAYS) as AttributionWindow[];
  const baseDates = windows.map((w) => daysBefore(today, WINDOW_DAYS[w]));
  const { data: walletSnaps, error: snapError } = await (await userDb())
    .from("wallet_snapshots")
    .select("wallet_id, snapshot_date, total_usd")
    .in("snapshot_date", baseDates);
  if (snapError) throw new Error(`Failed to load wallet snapshots: ${snapError.message}`);
  const byWallet = Object.fromEntries(
    windows.map((win, i) => {
      const base = new Map<string, number>();
      for (const r of walletSnaps as { wallet_id: string; snapshot_date: string; total_usd: number | string }[]) {
        if (r.snapshot_date === baseDates[i]) base.set(r.wallet_id, parseNumeric(r.total_usd) ?? 0);
      }
      return [win, attributeByWallet(win, walletInputs, base, today)];
    }),
  ) as AnalyticsView["byWallet"];

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
    byWallet,
    unpricedCount: grand.unpricedCount,
    attribution,
    risk,
    holdings,
    smallHoldings: { count: small.length, usd: small.reduce((s, g) => s + g.total, 0) },
  };
}

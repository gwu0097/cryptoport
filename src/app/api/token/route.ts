import type { NextRequest } from "next/server";
import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { userDb } from "@/lib/supabase";
import { getMarketFor } from "@/lib/queries";
import { getCoinContracts } from "@/lib/coinContractsQuery";
import { getPriceHistoryMap } from "@/lib/priceHistory";
import { resolveTradingViewSymbol } from "@/lib/adapters/exchangeListings";
import { chainDisplayName, defaultChainId } from "@/lib/chainNames";
import { buildTokenOverview, type TokenHoldingRow } from "@/lib/tokenOverview";

export const dynamic = "force-dynamic";

/**
 * GET /api/token?key=<price_key> — the token drawer's Overview (owner
 * 2026-10-09): which of the user's wallets hold the coin, its price and
 * changes, its contracts, the watchlists it's on, and what to chart. Four
 * reads at once (the user's holdings of it with their wallets — RLS; its
 * price row; its contracts; their watchlist items), then our daily closes only
 * when TradingView has no chart for it. A route handler, so opening a token
 * never waits in the Server Action queue.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const guard = await guardUser("token", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  const key = request.nextUrl.searchParams.get("key")?.trim() ?? "";
  if (!key || key.length > 160) return Response.json({ error: "key required" }, { status: 400 });

  const db = await userDb();
  const [holdingsRes, market, contracts, watchRes] = await Promise.all([
    db.from("holdings").select("ticker, qty, usd_override, source, price_key, chain, protocol, wallets!inner(id, name, chain, active)").eq("price_key", key).eq("wallets.active", true),
    getMarketFor([key]),
    getCoinContracts([key]),
    db.from("watchlist_items").select("watchlist_id, watchlists(name)").eq("coingecko_id", key),
  ]);
  if (holdingsRes.error) return Response.json({ error: holdingsRes.error.message }, { status: 500 });

  type Joined = { ticker: string; qty: number | string | null; usd_override: number | string | null; source: TokenHoldingRow["source"]; price_key: string | null; chain: string | null; protocol: string | null; wallets: { id: string; name: string; chain: string } };
  const holdings: TokenHoldingRow[] = (holdingsRes.data as unknown as Joined[]).map((h) => ({
    ticker: h.ticker,
    qty: h.qty,
    usd_override: h.usd_override,
    source: h.source,
    price_key: h.price_key,
    protocol: h.protocol,
    walletId: h.wallets.id,
    walletName: h.wallets.name,
    chainName: chainDisplayName(h.chain ?? defaultChainId(h.wallets.chain)),
  }));
  const s = market.stats.get(key) ?? null;
  const stats = s && { usd: s.usd, change1h: s.change1h, change24h: s.change24h, change7d: s.change7d, change30d: s.change30d, marketCap: s.marketCap, volume24h: s.volume24h, updatedAt: s.updatedAt, symbol: s.symbol, name: s.name, imageUrl: s.imageUrl };
  const ticker = (s?.symbol ?? holdings[0]?.ticker ?? "").toUpperCase();

  // TradingView's chart when it lists the coin (the shared lookup every chart
  // uses), else our own daily closes for the last 180 days. Only a CoinGecko
  // coin is looked up there by ticker: a key with a source prefix (jup:,
  // nearcom:, hl:…) is a coin TradingView's ticker would likely name wrongly
  // (QTC → Crypto.com's QTCUSD, a different coin, 2026-10-09).
  const tv = !key.includes(":") && /^[A-Z0-9]{1,20}$/.test(ticker) ? await resolveTradingViewSymbol(ticker).catch(() => null) : null;
  let closes: [string, number][] = [];
  if (!tv?.listed) {
    const { history } = await getPriceHistoryMap([{ ticker: ticker || key, source: "auto", contract: null, chain: null, coingecko_id: key, price_key: key }]);
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    closes = [...(history.get(key) ?? new Map<string, number>())].filter(([d]) => d >= since).sort(([a], [b]) => a.localeCompare(b));
  }

  type Watch = { watchlist_id: string; watchlists: { name: string } | null };
  const watchlists = ((watchRes.data ?? []) as unknown as Watch[]).map((w) => ({ id: w.watchlist_id, name: w.watchlists?.name ?? "Watchlist" }));

  return Response.json(
    buildTokenOverview({ key, holdings, prices: market.prices, stats, contracts: contracts.get(key) ?? [], watchlists, tradingView: tv?.listed ? ticker : null, closes }),
    { headers: { "cache-control": "no-store" } },
  );
}

import "server-only";
import { tradingViewSymbolFor, guessTradingViewSymbol, type TradingViewExchange } from "@/lib/tradingViewSymbol";

// Which exchange's TradingView chart to show for a ticker: Binance if it
// lists <TICKER>USDT, else MEXC (reported directly — many tokens showed
// TradingView's "This symbol doesn't exist" because the chart assumed
// Binance), else the plain Binance guess. Live-verified 2026-09-22:
//  - Binance's main API geo-blocks US IPs (HTTP 451 — Vercel runs in the
//    US); its public market-data mirror data-api.binance.vision answers
//    exchangeInfo?symbol= with 200 (listed) / 400 (not listed).
//  - MEXC exchangeInfo?symbol= returns 200 either way; an unlisted pair has
//    an empty `symbols` array, a listed one status "1".
// Listings change slowly, so results (including "not listed") are cached
// per server instance for a day. Note a symbol collision is possible (a
// different token using the same ticker on that exchange) — the chart's own
// symbol search remains the correction.

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { exchange: TradingViewExchange | null; at: number }>();

async function listedOnBinance(pair: string): Promise<boolean> {
  const res = await fetch(`https://data-api.binance.vision/api/v3/exchangeInfo?symbol=${pair}`, { cache: "no-store" });
  if (res.status === 200) return true;
  if (res.status === 400) return false;
  throw new Error(`Binance exchangeInfo HTTP ${res.status}`);
}

async function listedOnMexc(pair: string): Promise<boolean> {
  const res = await fetch(`https://api.mexc.com/api/v3/exchangeInfo?symbol=${pair}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`MEXC exchangeInfo HTTP ${res.status}`);
  const body: { symbols?: { symbol: string; status?: string }[] } = await res.json();
  return (body.symbols ?? []).some((s) => s.symbol === pair && s.status === "1");
}

export interface ResolvedChartSymbol {
  symbol: string; // e.g. "MEXC:WENUSDT"
  exchange: TradingViewExchange | null; // null = no listing confirmed; symbol is the Binance guess
}

export async function resolveTradingViewSymbol(ticker: string): Promise<ResolvedChartSymbol> {
  const t = ticker.toUpperCase();
  const hit = cache.get(t);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { symbol: hit.exchange ? tradingViewSymbolFor(hit.exchange, t) : guessTradingViewSymbol(t), exchange: hit.exchange };
  }
  const pair = `${t}USDT`;
  let exchange: TradingViewExchange | null = null;
  try {
    if (await listedOnBinance(pair)) exchange = "BINANCE";
    else if (await listedOnMexc(pair)) exchange = "MEXC";
  } catch {
    // An exchange API hiccup isn't evidence of anything — don't cache it; fall back to the guess this once.
    return { symbol: guessTradingViewSymbol(t), exchange: null };
  }
  cache.set(t, { exchange, at: Date.now() });
  return { symbol: exchange ? tradingViewSymbolFor(exchange, t) : guessTradingViewSymbol(t), exchange };
}

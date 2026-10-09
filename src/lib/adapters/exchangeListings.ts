import "server-only";
import { tradingViewSymbolFor, guessTradingViewSymbol, type TradingViewExchange } from "@/lib/tradingViewSymbol";
import { pickTradingViewSymbol, type SearchResult } from "@/lib/tradingViewPick";

// Which exchange's TradingView chart to show for a ticker: TradingView's own
// symbol search first (resolveTradingViewSymbol, below); when that refuses,
// Binance if it lists <TICKER>USDT, else MEXC (reported directly — many tokens showed
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
  symbol: string; // e.g. "COINBASE:PYTHUSD"
  exchange: TradingViewExchange | null; // null = no listing confirmed; symbol is the Binance guess
  /** A spot pair was found on some exchange. False: TradingView has no
   * chart for it — the token drawer shows our own closes instead. */
  listed: boolean;
}

// TradingView's own symbol search (owner 2026-10-09: the chart picked the
// wrong exchange — PYTH and JUP aren't on Binance spot as USDT pairs the way
// the probe assumed, but on Coinbase, Kraken, Bitstamp…). One call answers
// every exchange; unofficial (TradingView's site uses it), so a refusal falls
// back to the Binance/MEXC probes below. Answered from a server with these
// headers on 2026-10-09.
const SEARCH = "https://symbol-search.tradingview.com/symbol_search/v3/";
const SEARCH_HEADERS = { "User-Agent": "Mozilla/5.0", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/" };

async function searchListing(ticker: string): Promise<string | null> {
  const res = await fetch(`${SEARCH}?text=${encodeURIComponent(ticker)}&search_type=crypto&exchange=&lang=en&domain=production`, { headers: SEARCH_HEADERS, cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`TradingView search HTTP ${res.status}`);
  const body = (await res.json()) as { symbols?: SearchResult[] };
  if (!Array.isArray(body.symbols)) throw new Error("TradingView search: unexpected answer");
  return pickTradingViewSymbol(ticker, body.symbols);
}

const searched = new Map<string, { symbol: string | null; at: number }>();

export async function resolveTradingViewSymbol(ticker: string): Promise<ResolvedChartSymbol> {
  const t = ticker.toUpperCase();
  const hit = searched.get(t);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.symbol ? { symbol: hit.symbol, exchange: hit.symbol.split(":")[0], listed: true } : { symbol: guessTradingViewSymbol(t), exchange: null, listed: false };
  try {
    const symbol = await searchListing(t);
    searched.set(t, { symbol, at: Date.now() });
    return symbol ? { symbol, exchange: symbol.split(":")[0], listed: true } : { symbol: guessTradingViewSymbol(t), exchange: null, listed: false };
  } catch {
    return probeListing(t);
  }
}

/** The fallback when the search refuses: Binance then MEXC USDT pairs. */
async function probeListing(t: string): Promise<ResolvedChartSymbol> {
  const hit = cache.get(t);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { symbol: hit.exchange ? tradingViewSymbolFor(hit.exchange, t) : guessTradingViewSymbol(t), exchange: hit.exchange, listed: !!hit.exchange };
  }
  const pair = `${t}USDT`;
  let exchange: TradingViewExchange | null = null;
  try {
    if (await listedOnBinance(pair)) exchange = "BINANCE";
    else if (await listedOnMexc(pair)) exchange = "MEXC";
  } catch {
    // An exchange API hiccup isn't evidence of anything — don't cache it; fall back to the guess this once.
    return { symbol: guessTradingViewSymbol(t), exchange: null, listed: true };
  }
  cache.set(t, { exchange, at: Date.now() });
  return { symbol: exchange ? tradingViewSymbolFor(exchange, t) : guessTradingViewSymbol(t), exchange, listed: !!exchange };
}

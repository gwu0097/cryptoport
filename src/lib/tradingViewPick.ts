// Which TradingView symbol to chart for a ticker, from TradingView's own symbol
// search (owner 2026-10-09: the chart showed the wrong exchange — "Binance
// might not have it but Bitstamp does"). Pure.
//
// Only a spot pair of exactly <TICKER><QUOTE> counts (no perps ".P", no
// indexes, no other coin whose ticker merely starts the same), quoted in USDT,
// USD or USDC; the biggest exchange that lists it wins. None → null, and the
// caller charts our own closes instead of a "symbol doesn't exist" chart.

export interface SearchResult {
  symbol?: string;
  type?: string;
  source_id?: string;
  prefix?: string;
  currency_code?: string;
}

/** Most liquid first: where a coin's chart reflects its real price. */
const EXCHANGES = ["BINANCE", "COINBASE", "OKX", "BYBIT", "KRAKEN", "BITGET", "KUCOIN", "GATEIO", "MEXC", "BITSTAMP", "CRYPTO", "GEMINI", "HTX", "BITFINEX"];
const QUOTES = ["USDT", "USD", "USDC"];

const clean = (s: string | undefined) => (s ?? "").replace(/<\/?em>/g, "").toUpperCase();

export function pickTradingViewSymbol(ticker: string, results: readonly SearchResult[]): string | null {
  const t = ticker.toUpperCase();
  let best: { rank: number; symbol: string } | null = null;
  for (const r of results) {
    if (r.type !== "spot") continue;
    const exchange = clean(r.source_id ?? r.prefix);
    const symbol = clean(r.symbol);
    const quote = QUOTES.findIndex((q) => symbol === `${t}${q}`);
    if (!exchange || quote < 0) continue;
    const ex = EXCHANGES.indexOf(exchange);
    // Listed exchanges in order, quotes in order within each; any other exchange after.
    const rank = (ex < 0 ? EXCHANGES.length : ex) * QUOTES.length + quote;
    if (!best || rank < best.rank) best = { rank, symbol: `${exchange}:${symbol}` };
  }
  return best?.symbol ?? null;
}

/** TradingView symbol for a ticker on an exchange's USDT spot pair. */
export function tradingViewSymbolFor(exchange: TradingViewExchange, ticker: string): string {
  return `${exchange}:${ticker.toUpperCase()}USDT`;
}

export type TradingViewExchange = "BINANCE" | "MEXC";

/** The fallback when no listing was confirmed (or before one resolves):
 * Binance, the widest-coverage major exchange. TradingView's own symbol
 * search returns a hard 403 to non-browser requests (live-verified), so
 * which exchange actually lists a ticker is resolved against the exchanges'
 * own public APIs instead — see adapters/exchangeListings.ts. The embedded
 * widget's allow_symbol_change still lets a wrong pick be corrected by hand. */
export function guessTradingViewSymbol(ticker: string): string {
  return tradingViewSymbolFor("BINANCE", ticker);
}

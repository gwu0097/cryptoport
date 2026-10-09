/** TradingView symbol for a ticker on an exchange's USDT spot pair. */
export function tradingViewSymbolFor(exchange: TradingViewExchange, ticker: string): string {
  return `${exchange}:${ticker.toUpperCase()}USDT`;
}

/** A TradingView exchange code (BINANCE, COINBASE, OKX…). */
export type TradingViewExchange = string;

/** The fallback when no listing was confirmed (or before one resolves):
 * Binance, the widest-coverage major exchange. Which exchange actually
 * lists a ticker is resolved by adapters/exchangeListings.ts (TradingView's
 * own symbol search, else the exchanges' APIs). The embedded widget's
 * allow_symbol_change still lets a wrong pick be corrected by hand. */
export function guessTradingViewSymbol(ticker: string): string {
  return tradingViewSymbolFor("BINANCE", ticker);
}

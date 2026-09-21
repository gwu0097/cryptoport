/** Best-guess TradingView symbol for a bare ticker. TradingView's own
 * symbol-search API (which would let this resolve the *correct* exchange
 * listing per ticker) is undocumented and returns a hard 403 for
 * non-browser requests — live-verified this session, not assumed; not
 * something to build on. Binance has by far the widest crypto listing
 * coverage of the major exchanges, so it's used as a default guess rather
 * than trying to solve exchange resolution server-side — the embedded
 * widget's own `allow_symbol_change` (see TradingViewCompareChart.tsx)
 * is what makes a wrong or unlisted guess correctable by hand instead of
 * a dead end. */
export function guessTradingViewSymbol(ticker: string): string {
  return `BINANCE:${ticker.toUpperCase()}USDT`;
}

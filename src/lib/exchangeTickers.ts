// Which coin each exchange ticker is, from CoinGecko's per-exchange market
// data (/exchanges/{id}/tickers: every pair the exchange trades, with the
// coin id of its base). Replaces copying Coinbase's catalog to other
// exchanges — a ticker can mean a different coin on another venue, and
// venue-only names (Kraken's XDG for DOGE) never appear in Coinbase's list.
// Pure (no network): adapters/exchangeTickers.ts fetches the pages.

export interface ExchangeTicker {
  base?: string;
  coin_id?: string;
}

/** Our exchange chain id -> CoinGecko's exchange id ("gdax" is Coinbase
 * Exchange). */
export const COINGECKO_EXCHANGE_IDS: Record<string, string> = { coinbase: "gdax", kraken: "kraken", gemini: "gemini", mexc: "mxc" };

/** Where an exchange's name for a coin differs from the ticker its balances
 * are stored under (the Kraken adapter renames XBT to BTC). */
const BASE_ALIASES: Record<string, Record<string, string>> = { kraken: { XBT: "BTC" } };

/** Ticker -> coin id for one exchange. A ticker whose pairs name more than
 * one coin is left out, never guessed. */
export function mappingsFromTickers(exchange: string, tickers: readonly ExchangeTicker[]): Map<string, string> {
  const ids = new Map<string, Set<string>>();
  for (const t of tickers) {
    if (!t.base || !t.coin_id) continue;
    const raw = t.base.toUpperCase();
    const ticker = BASE_ALIASES[exchange]?.[raw] ?? raw;
    ids.set(ticker, (ids.get(ticker) ?? new Set()).add(t.coin_id));
  }
  return new Map([...ids].filter(([, s]) => s.size === 1).map(([ticker, s]) => [ticker, [...s][0]]));
}

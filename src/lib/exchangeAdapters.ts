import "server-only";
import { fetchCoinbaseBalances } from "./adapters/coinbaseAdvancedTrade";
import { fetchKrakenBalances } from "./adapters/kraken";
import { fetchGeminiBalances } from "./adapters/gemini";
import { fetchMexcBalances } from "./adapters/mexc";
import type { AdapterHolding } from "./adapters/types";

export interface ExchangeFetchResult {
  holdings: AdapterHolding[];
  warnings: string[];
}

export type ExchangeFetcher = (keyName: string, secret: string) => Promise<ExchangeFetchResult>;

/**
 * One entry per EXCHANGE_PROVIDERS id — the real "test this key, fetch
 * balances" call connectExchange/syncExchangeHoldings (wallets/actions.ts)
 * dispatch to by `wallets.provider`/`exchange_connections.provider`.
 * Extracted once Kraken and Gemini became the second and third copy of
 * what connectCoinbase/syncCoinbaseHoldings used to hardcode — past this
 * codebase's own "two existing copies is the threshold to share" rule —
 * so the next exchange is "a new adapter file + one line here," not
 * another near-duplicate pair of Server Actions.
 */
export const EXCHANGE_ADAPTERS: Record<string, ExchangeFetcher> = {
  coinbase: fetchCoinbaseBalances,
  kraken: fetchKrakenBalances,
  gemini: fetchGeminiBalances,
  mexc: fetchMexcBalances,
};

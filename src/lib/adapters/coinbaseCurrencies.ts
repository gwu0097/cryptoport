import "server-only";
import { fetchWithRetry } from "./http.ts";

// Coinbase's public Exchange API — a different host/shape from both
// coinbase.ts's pricing endpoints (api.coinbase.com/v2/prices,
// api.exchange.coinbase.com/products) and coinbaseAdvancedTrade.ts's
// authenticated balance fetch (api.coinbase.com/api/v3/brokerage). No auth,
// no user key needed — this is Coinbase's own public asset catalog, not
// anything account-specific.
const CURRENCIES_URL = "https://api.exchange.coinbase.com/currencies";

export interface CoinbaseCurrency {
  /** Coinbase's own currency id, e.g. "UNI" — always uppercase in practice. */
  ticker: string;
  /** Full asset name, e.g. "Uniswap" — safer to search CoinGecko by than the
   * bare ticker (see exchangeAssetRegistry.ts's own doc comment: full names
   * collide far less than 3-4 letter symbols). */
  name: string;
  /** Coinbase's own network id for the network carrying a contract_address
   * (e.g. "ethereum", "solana"), or null when this asset has no on-chain
   * contract at all (a native L1 asset, e.g. ALGO). */
  network: string | null;
  /** Lowercase contract address on `network`, or null. */
  contract: string | null;
}

interface CoinbaseCurrencyResponse {
  id: string;
  name: string;
  status: string;
  details?: { type?: string };
  default_network?: string;
  supported_networks?: { id: string; contract_address?: string | null }[];
}

/**
 * Every currently-tradable crypto asset Coinbase lists, each with its real
 * on-chain contract address when one exists — free, public, keyless. This
 * is what lets a bare Coinbase/Kraken/Gemini exchange-balance ticker
 * (which has no contract of its own — see coinbaseAdvancedTrade.ts's own
 * doc comment on why) resolve to a *verified* identity instead of either
 * guessing off the ticker or falling back to a slow, rate-limited
 * per-ticker pricing API call. See exchangeAssetRegistry.ts, the one
 * caller — this file only fetches/shapes the raw catalog.
 */
export async function fetchCoinbaseCurrencies(): Promise<CoinbaseCurrency[]> {
  const res = await fetchWithRetry(CURRENCIES_URL);
  if (!res.ok) throw new Error(`Coinbase currencies fetch failed: HTTP ${res.status}`);
  const body: CoinbaseCurrencyResponse[] = await res.json();

  return body
    .filter((c) => c.status === "online" && c.details?.type === "crypto")
    .map((c) => {
      const networks = c.supported_networks ?? [];
      const withContract = networks.find((n) => n.contract_address);
      return {
        ticker: c.id.toUpperCase(),
        name: c.name,
        network: withContract?.id ?? c.default_network ?? null,
        contract: withContract?.contract_address ? withContract.contract_address.toLowerCase() : null,
      };
    });
}

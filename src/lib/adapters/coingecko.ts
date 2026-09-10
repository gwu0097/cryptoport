import "server-only";
import { fetchWithRetry } from "./http";
import { EVM_CHAINS } from "./evmChains";
import { portfolioDb } from "../supabase";

const API_BASE = "https://api.coingecko.com/api/v3";

// Optional: without a key, CoinGecko's public tier still works (verified —
// coins/list and simple/token_price both respond with no auth), but caps
// simple/token_price at 1 contract address per call, which is slow for a
// chain with 100+ registered tokens. A free Demo key (no payment) raises
// that batch size substantially. Falls back to single-address calls when
// unset, so this works out of the box either way.
const API_KEY = process.env.COINGECKO_API_KEY;
const PRICE_BATCH_SIZE = API_KEY ? 100 : 1;

function headers(): Record<string, string> {
  return API_KEY ? { "x-cg-demo-api-key": API_KEY } : {};
}

interface CoinListEntry {
  id: string;
  symbol: string;
  platforms?: Record<string, string>;
}

/**
 * Refreshes cryptoport.token_registry from CoinGecko's coins/list — one
 * call covers every chain in EVM_CHAINS (and every chain CoinGecko knows
 * about; this only keeps the ones matching a configured platform id).
 * Upsert, not replace: a token that drops out of a later CoinGecko listing
 * doesn't lose its already-known decimals.
 */
export async function refreshTokenRegistry(): Promise<{ chainId: string; count: number }[]> {
  const res = await fetchWithRetry(`${API_BASE}/coins/list?include_platform=true`, { headers: headers() });
  if (!res.ok) throw new Error(`CoinGecko coins/list failed: HTTP ${res.status}`);
  const coins: CoinListEntry[] = await res.json();

  const results: { chainId: string; count: number }[] = [];

  for (const chain of EVM_CHAINS) {
    const rows = coins
      .filter((c) => c.platforms?.[chain.coingeckoPlatform])
      .map((c) => ({
        chain_id: chain.id,
        contract: c.platforms![chain.coingeckoPlatform].toLowerCase(),
        symbol: c.symbol.toUpperCase(),
        coingecko_id: c.id,
        updated_at: new Date().toISOString(),
      }))
      .filter((r) => r.contract && r.contract !== "");

    // Upsert in chunks — Supabase/PostgREST has a practical payload-size
    // ceiling, and some chains (Ethereum, BSC) have tens of thousands of
    // registered contracts.
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const { error } = await portfolioDb()
        .from("token_registry")
        .upsert(chunk, { onConflict: "chain_id,contract", ignoreDuplicates: false });
      if (error) throw new Error(`Failed to upsert token_registry(${chain.id}): ${error.message}`);
    }

    results.push({ chainId: chain.id, count: rows.length });
  }

  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** contract (lowercase) -> usd price, only for contracts CoinGecko can price. */
export async function fetchTokenPrices(
  coingeckoPlatform: string,
  contracts: string[],
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (contracts.length === 0) return prices;

  for (const batch of chunk(contracts, PRICE_BATCH_SIZE)) {
    const url = `${API_BASE}/simple/token_price/${coingeckoPlatform}?contract_addresses=${batch.join(",")}&vs_currencies=usd`;
    const res = await fetchWithRetry(url, { headers: headers() });
    if (!res.ok) throw new Error(`CoinGecko token_price(${coingeckoPlatform}) failed: HTTP ${res.status}`);
    const body: Record<string, { usd?: number }> = await res.json();
    for (const [contract, price] of Object.entries(body)) {
      if (typeof price.usd === "number") prices.set(contract.toLowerCase(), price.usd);
    }
  }

  return prices;
}

export async function fetchNativePrice(coingeckoId: string): Promise<number | null> {
  const url = `${API_BASE}/simple/price?ids=${coingeckoId}&vs_currencies=usd`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`CoinGecko simple/price(${coingeckoId}) failed: HTTP ${res.status}`);
  const body: Record<string, { usd?: number }> = await res.json();
  return body[coingeckoId]?.usd ?? null;
}

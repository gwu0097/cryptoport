import "server-only";
import { fetchWithRetry } from "./http";
import { EVM_CHAINS } from "./evmChains";
import { serviceDb } from "../supabase";

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

interface AssetPlatform {
  id: string;
  image?: { small?: string };
}

// Chain ids this app has that aren't in EVM_CHAINS (so have no
// `coingeckoPlatform` of their own to look up by) but still correspond to a
// real CoinGecko asset_platforms entry, keyed by that platform's own id.
const NON_EVM_PLATFORM_IDS: Record<string, string> = {
  solana: "solana",
  hyperliquid: "hyperliquid",
  cardano: "cardano",
};

// Non-EVM chains with no CoinGecko asset_platforms entry at all — see the
// native-icon fallback in refreshTokenRegistry below.
const NATIVE_ICON_CHAINS: Record<string, string> = {
  bitcoin: "bitcoin",
  "solana-defi": "solana",
  cosmoshub: "cosmos",
  injective: "injective-protocol",
  near: "near",
  sui: "sui",
  filecoin: "filecoin",
  bitcoincash: "bitcoin-cash",
  polkadot: "polkadot",
  bittensor: "bittensor",
  neo: "neo",
  xrpl: "ripple",
  ton: "the-open-network",
  aptos: "aptos",
  "internet-computer": "internet-computer",
};

/**
 * Refreshes cryptoport.token_registry from CoinGecko's coins/list — one
 * call covers every chain in EVM_CHAINS (and every chain CoinGecko knows
 * about; this only keeps the ones matching a configured platform id).
 * Upsert, not replace: a token that drops out of a later CoinGecko listing
 * doesn't lose its already-known decimals.
 *
 * Also refreshes cryptoport.chain_icons from the same CoinGecko
 * asset_platforms endpoint this app already trusts for coingeckoPlatform /
 * nativeCoingeckoId (see evmChains.ts) — every chain currently configured
 * has a real logo there (verified against all 30 + solana + hyperliquid),
 * keyed by the same `coingeckoPlatform` id already stored per chain. This
 * is what makes chain icons keep working without a hand-maintained URL
 * list: add a chain to EVM_CHAINS, run this once, its icon is there too.
 */
export async function refreshTokenRegistry(): Promise<{ chainId: string; count: number }[]> {
  const [coinsRes, platformsRes] = await Promise.all([
    fetchWithRetry(`${API_BASE}/coins/list?include_platform=true`, { headers: headers() }),
    fetchWithRetry(`${API_BASE}/asset_platforms`, { headers: headers() }),
  ]);
  if (!coinsRes.ok) throw new Error(`CoinGecko coins/list failed: HTTP ${coinsRes.status}`);
  if (!platformsRes.ok) throw new Error(`CoinGecko asset_platforms failed: HTTP ${platformsRes.status}`);
  const coins: CoinListEntry[] = await coinsRes.json();
  const platforms: AssetPlatform[] = await platformsRes.json();
  const platformImages = new Map(
    platforms.filter((p) => p.image?.small).map((p) => [p.id, p.image!.small!]),
  );

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
      const { error } = await serviceDb()
        .from("token_registry")
        .upsert(chunk, { onConflict: "chain_id,contract", ignoreDuplicates: false });
      if (error) throw new Error(`Failed to upsert token_registry(${chain.id}): ${error.message}`);
    }

    results.push({ chainId: chain.id, count: rows.length });
  }

  const chainIconRows = [
    ...EVM_CHAINS.map((c) => ({ chain_id: c.id, platformId: c.coingeckoPlatform })),
    ...Object.entries(NON_EVM_PLATFORM_IDS).map(([chainId, platformId]) => ({ chain_id: chainId, platformId })),
  ]
    .map((r) => ({ chain_id: r.chain_id, image_url: platformImages.get(r.platformId) }))
    .filter((r): r is { chain_id: string; image_url: string } => Boolean(r.image_url));

  // Chains with no CoinGecko asset_platforms entry (not smart-contract
  // platforms — no concept of "tokens on this chain" in CoinGecko's model)
  // — their own native coin's image doubles as the chain-brand icon
  // instead. Extend this as new non-platform chains get adapters (started
  // with just Bitcoin; Cosmos SDK chains added alongside cosmos.ts).
  const nativeIconImages = await fetchTokenImages(Object.values(NATIVE_ICON_CHAINS)).catch(
    () => new Map<string, string>(),
  );
  for (const [chainId, coingeckoId] of Object.entries(NATIVE_ICON_CHAINS)) {
    const image = nativeIconImages.get(coingeckoId);
    if (image) chainIconRows.push({ chain_id: chainId, image_url: image });
  }

  if (chainIconRows.length > 0) {
    const { error } = await serviceDb().from("chain_icons").upsert(chainIconRows, { onConflict: "chain_id" });
    if (error) throw new Error(`Failed to upsert chain_icons: ${error.message}`);
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

const IMAGE_BATCH_SIZE = 250; // coins/markets' own per-call ids cap

/** coingecko_id -> logo URL, for whichever of the given ids CoinGecko has
 * an image for. Used to populate token_registry.image_url (contract-based
 * tokens) and for EVM native-token icons (fetched fresh each time — see
 * multicallEvm.ts, there are only ~15 distinct native ids so this isn't
 * worth a separate cache table). */
export async function fetchTokenImages(coingeckoIds: string[]): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  if (coingeckoIds.length === 0) return images;

  for (const batch of chunk(coingeckoIds, IMAGE_BATCH_SIZE)) {
    const url = `${API_BASE}/coins/markets?vs_currency=usd&ids=${batch.join(",")}&sparkline=false`;
    const res = await fetchWithRetry(url, { headers: headers() });
    if (!res.ok) throw new Error(`CoinGecko coins/markets failed: HTTP ${res.status}`);
    const body: { id: string; image?: string }[] = await res.json();
    for (const coin of body) {
      if (coin.image) images.set(coin.id, coin.image);
    }
  }

  return images;
}

export async function fetchNativePrice(coingeckoId: string): Promise<number | null> {
  const url = `${API_BASE}/simple/price?ids=${coingeckoId}&vs_currencies=usd`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`CoinGecko simple/price(${coingeckoId}) failed: HTTP ${res.status}`);
  const body: Record<string, { usd?: number }> = await res.json();
  return body[coingeckoId]?.usd ?? null;
}

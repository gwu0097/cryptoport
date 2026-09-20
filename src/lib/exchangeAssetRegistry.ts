import "server-only";
import { serviceDb } from "./supabase.ts";
import { fetchCoinbaseCurrencies, type CoinbaseCurrency } from "./adapters/coinbaseCurrencies.ts";
import { searchCoins, type CoinSearchResult } from "./adapters/coingecko.ts";

const TTL_MS = 24 * 60 * 60 * 1000; // slow-changing catalog — doesn't need to be fresher

// Coinbase's own network id -> this app's chain_id vocabulary. Only needs to
// cover networks Coinbase's real catalog actually uses for a contract-
// bearing asset — live-checked (2026-09): ethereum(225)/base(66)/
// solana(54)/polygon(6)/arbitrum(4)/avacchain(4)/optimism(4)/bsc(2)/celo(1)
// cover 366 of 372 contract-bearing assets (98%); a handful on sui/tempo/
// injective have no equivalent chain in this app's own vocabulary and are
// deliberately left unresolved (see below) rather than guessed at.
const NETWORK_TO_CHAIN_ID: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  solana: "solana",
  polygon: "matic",
  arbitrum: "arb",
  avacchain: "avax",
  optimism: "op",
  bsc: "bsc",
  celo: "celo",
};

const TOKEN_REGISTRY_CHUNK_SIZE = 150; // a single .in() call over ~360 contracts blew PostgREST's 16KB header limit — live-verified

/** Contract-bearing assets on a network this app tracks: resolved through
 * `token_registry` (already populated by refreshTokenRegistry, no second
 * CoinGecko coins-list fetch needed) — same "a contract address is already
 * globally unique in practice" simplification queries.ts's
 * getContractStatsMap already relies on, so this isn't chain-scoped either.
 * Chunked, not one `.in()` call — Coinbase's real catalog has ~360
 * contract-bearing assets, and a single query with that many values in the
 * URL exceeds PostgREST's request-header size limit (a real
 * HeadersOverflowError, caught live while verifying this). */
async function resolveViaTokenRegistry(currencies: CoinbaseCurrency[]): Promise<Map<string, string>> {
  const eligible = currencies.filter((c) => c.contract && c.network && NETWORK_TO_CHAIN_ID[c.network]);
  if (eligible.length === 0) return new Map();

  const contracts = eligible.map((c) => c.contract!.toLowerCase());
  const idByContract = new Map<string, string>();
  for (let i = 0; i < contracts.length; i += TOKEN_REGISTRY_CHUNK_SIZE) {
    const chunk = contracts.slice(i, i + TOKEN_REGISTRY_CHUNK_SIZE);
    const { data, error } = await serviceDb()
      .from("token_registry")
      .select("contract, coingecko_id")
      .in("contract", chunk)
      .not("coingecko_id", "is", null);
    if (error) throw new Error(`Failed to read token_registry: ${error.message}`);
    for (const r of data as { contract: string; coingecko_id: string }[]) {
      idByContract.set(r.contract.toLowerCase(), r.coingecko_id);
    }
  }
  const result = new Map<string, string>();
  for (const c of eligible) {
    const id = idByContract.get(c.contract!.toLowerCase());
    if (id) result.set(c.ticker, id);
  }
  return result;
}

/** Exact-symbol match only, never a fuzzy fallback — unlike
 * watchlistInput.ts's pickBestMatch (which deliberately falls back to the
 * top search result when nothing matches the symbol exactly, because a
 * human reviews the pick before it's committed to a watchlist), this feeds
 * PRICING data with nothing reviewing it — a non-matching "best available"
 * guess here would be exactly the plausible-looking-wrong-number the Data
 * Correctness rule forbids. Null (never priced) is the safe outcome when
 * nothing matches. */
function pickVerifiedMatch(ticker: string, results: CoinSearchResult[]): CoinSearchResult | null {
  const upper = ticker.toUpperCase();
  const exact = results.filter((r) => r.symbol.toUpperCase() === upper);
  if (exact.length === 0) return null;
  return exact.reduce((best, r) => {
    if (r.marketCapRank === null) return best;
    if (best.marketCapRank === null) return r;
    return r.marketCapRank < best.marketCapRank ? r : best;
  });
}

/** Native/L1 Coinbase assets with no contract at all (ALGO, TIA, AKT, ...).
 * Searched by the asset's full NAME (e.g. "Algorand"), not its bare ticker
 * — CoinGecko's /search ranks by relevance across every coin sharing a
 * fragment of the query, and a full name collides with far fewer unrelated
 * coins than a 3-4 letter symbol does. The result is still required to
 * carry the exact right symbol (pickVerifiedMatch) before being trusted —
 * belt and suspenders, not just "the top name match." Sequential, not
 * parallel: this only ever runs during the 24h-TTL registry refresh, never
 * per price-refresh, so there's no latency pressure — matches this app's
 * own "don't burst a free API" discipline elsewhere (CATEGORY_FETCH_OPTS). */
async function resolveNativeViaSearch(currencies: CoinbaseCurrency[]): Promise<Map<string, string>> {
  const nativeOnly = currencies.filter((c) => !c.contract);
  const result = new Map<string, string>();
  for (const c of nativeOnly) {
    try {
      const candidates = await searchCoins(c.name);
      const match = pickVerifiedMatch(c.ticker, candidates);
      if (match) result.set(c.ticker, match.id);
    } catch {
      // best-effort, per-asset — one failed search shouldn't stop the rest
    }
  }
  return result;
}

/**
 * Refreshes cryptoport.exchange_asset_registry from Coinbase's public
 * currency catalog when it's stale/empty — lazy-populate-on-read, no
 * user-facing button (same shape as resolveTickerIcons, with a TTL added
 * for the same reason coin_categories has one: a stale entry here silently
 * changes which peer/identity a ticker resolves to, not just a cosmetic
 * icon). Called from syncExchangeHoldings, not from inside the pricing
 * path — this function does real network calls (Coinbase's catalog, plus
 * one CoinGecko /search per native-only asset), which have no business
 * running on every "Refresh prices" click. Best-effort: a failed refresh
 * just means the registry stays at whatever it already had (possibly
 * empty on the very first sync ever), never a broken sync.
 */
export async function ensureExchangeAssetRegistry(): Promise<void> {
  try {
    const { data } = await serviceDb()
      .from("exchange_asset_registry")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const newest = data as { updated_at: string } | null;
    if (newest && Date.now() - new Date(newest.updated_at).getTime() < TTL_MS) return;

    const currencies = await fetchCoinbaseCurrencies();
    const [byContract, byName] = await Promise.all([
      resolveViaTokenRegistry(currencies),
      resolveNativeViaSearch(currencies),
    ]);

    const now = new Date().toISOString();
    const rows = currencies.map((c) => ({
      ticker: c.ticker,
      coingecko_id: byContract.get(c.ticker) ?? byName.get(c.ticker) ?? null,
      updated_at: now,
    }));

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await serviceDb().from("exchange_asset_registry").upsert(chunk, { onConflict: "ticker" });
      if (error) throw new Error(error.message);
    }
  } catch {
    // best-effort — see doc comment above
  }
}

/** ticker (uppercase) -> resolved CoinGecko id, skipping anything still
 * unresolved (null) — the plain read side, safe to call from the hot
 * pricing path (no network calls, no writes). */
export async function getExchangeAssetRegistry(): Promise<Map<string, string>> {
  const { data, error } = await serviceDb().from("exchange_asset_registry").select("ticker, coingecko_id").not("coingecko_id", "is", null);
  if (error) throw new Error(`Failed to load exchange_asset_registry: ${error.message}`);
  return new Map((data as { ticker: string; coingecko_id: string }[]).map((r) => [r.ticker, r.coingecko_id]));
}

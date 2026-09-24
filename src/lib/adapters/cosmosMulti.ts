import "server-only";
import { serviceDb } from "../supabase";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import { fetchMarketsByIds } from "./coingecko";
import { eligibleChains, deriveAddress, holdingsFromBalances, withRegistryApis, type CosmosHolding, type DirectoryChain } from "../cosmosMulti";

// Network half of the Cosmos multi-chain wallet (pure logic + the why:
// ../cosmosMulti.ts). A cosmos1… wallet's sync scans every live coin-type-118
// Cosmos chain in cosmos.directory's registry (~159) for the same account,
// and stores every token as an `auto_cosmos` holding (sync_cosmos_holdings):
// priced only by its own CoinGecko id, re-priced by "Refresh prices"
// (refreshCosmosHoldingPrices below), never by ticker.

const DIRECTORY_URL = "https://chains.cosmos.directory/";
const REGISTRY_RAW = "https://raw.githubusercontent.com/cosmos/chain-registry/master";
const CONCURRENCY = 12;
const PER_REQUEST_TIMEOUT_MS = 6_000;
// The sync runs in after() under the route's 300s maxDuration; stop starting
// new fallback attempts well before that. A chain not reached in time is
// reported as unreachable, never silently treated as empty.
const SCAN_DEADLINE_MS = 150_000;

export async function fetchCosmosMultiHoldings(cosmosAddress: string): Promise<{ holdings: CosmosHolding[]; warnings: string[] }> {
  const res = await fetchWithRetry(DIRECTORY_URL);
  if (!res.ok) throw new Error(`cosmos.directory chain list failed: HTTP ${res.status}`);
  const listed = eligibleChains(((await res.json()) as { chains: Parameters<typeof eligibleChains>[0] }).chains);
  if (listed.length === 0) throw new Error("cosmos.directory returned no eligible chains");
  // Chains the directory lists no healthy endpoint for: read their own
  // chain-registry chain.json for its REST list (small GitHub files, in parallel).
  const chains = await mapWithConcurrency(listed, CONCURRENCY, async (chain) => {
    if (!chain.needsRegistryApis) return chain;
    try {
      const r = await fetch(`${REGISTRY_RAW}/${chain.name}/chain.json`, { cache: "no-store", signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
      return withRegistryApis(chain, r.ok ? ((await r.json()) as Parameters<typeof withRegistryApis>[1]) : null);
    } catch {
      return withRegistryApis(chain, null);
    }
  });

  const started = Date.now();
  const results = await mapWithConcurrency(chains, CONCURRENCY, (chain) => scanChain(chain, cosmosAddress, started));
  const holdings = results.flatMap((r) => r.holdings);
  const unreachable = results.filter((r) => r.unreachable).map((r) => r.chain.prettyName);

  const warnings: string[] = [];
  if (unreachable.length > 0) {
    warnings.push(
      `${unreachable.length} of ${chains.length} Cosmos chains couldn't be reached (their tokens may be missing): ${unreachable.slice(0, 12).join(", ")}${unreachable.length > 12 ? ", …" : ""}`,
    );
  }
  const unrecognized = holdings.filter((h) => h.coingecko_id === null && h.qty === null).length;
  if (unrecognized > 0) warnings.push(`${unrecognized} unrecognized token(s) listed without an amount or price`);
  return { holdings, warnings };
}

async function scanChain(chain: DirectoryChain, cosmosAddress: string, started: number): Promise<{ chain: DirectoryChain; holdings: CosmosHolding[]; unreachable: boolean }> {
  const address = deriveAddress(cosmosAddress, chain.prefix);
  for (const base of chain.restUrls) {
    if (Date.now() - started > SCAN_DEADLINE_MS) break;
    try {
      const r = await fetch(`${base}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=1000`, {
        cache: "no-store",
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
      if (!r.ok) continue;
      const body = (await r.json()) as { balances?: { denom: string; amount: string }[] };
      if (!Array.isArray(body.balances)) continue;
      return { chain, holdings: holdingsFromBalances(chain, body.balances), unreachable: false };
    } catch {
      // timeout / network error: try the chain's next endpoint
    }
  }
  return { chain, holdings: [], unreachable: true };
}

/**
 * "Refresh prices" for Cosmos holdings: re-prices every `auto_cosmos` row
 * that has a CoinGecko id from CoinGecko's /coins/markets by that id (one
 * batched call per 250 ids, via the shared 60s price cache) — the Cosmos
 * counterpart of refreshEvmHoldingPrices. A row whose id gets no price this
 * time is set to unpriced rather than keeping an old number with no caption.
 */
export async function refreshCosmosHoldingPrices(): Promise<{ ticker: string; ok: boolean; error?: string }[]> {
  const db = serviceDb();
  const { data, error } = await db
    .from("holdings")
    .select("id, wallet_id, ticker, qty, coingecko_id")
    .eq("source", "auto_cosmos")
    .not("coingecko_id", "is", null);
  if (error) throw new Error(`Failed to load Cosmos holdings: ${error.message}`);
  const rows = (data ?? []) as { id: string; wallet_id: string; ticker: string; qty: number | string | null; coingecko_id: string }[];
  if (rows.length === 0) return [];

  const markets = await fetchMarketsByIds([...new Set(rows.map((r) => r.coingecko_id))]);
  const priceById = new Map(markets.map((m) => [m.id, m.price]));
  const upserts = rows.map((r) => {
    const price = priceById.get(r.coingecko_id) ?? null;
    const qty = r.qty === null ? null : Number(r.qty);
    return { id: r.id, wallet_id: r.wallet_id, ticker: r.ticker, source: "auto_cosmos", usd_override: price !== null && qty !== null ? qty * price : null };
  });
  const { error: upsertError } = await db.from("holdings").upsert(upserts, { onConflict: "id" });
  if (upsertError) throw new Error(`Failed to save Cosmos holding prices: ${upsertError.message}`);
  return upserts.map((u) => ({ ticker: u.ticker, ok: u.usd_override !== null, ...(u.usd_override === null ? { error: "No CoinGecko price for this id." } : {}) }));
}

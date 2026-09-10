import "server-only";
import { createPublicClient, http, formatUnits, type Address } from "viem";
import { EVM_CHAINS, MULTICALL3_ADDRESS, type EvmChain } from "./evmChains";
import { fetchNativePrice, fetchTokenPrices, fetchTokenImages } from "./coingecko";
import { mapWithConcurrency } from "./http";
import { portfolioDb } from "../supabase";
import type { AdapterHolding } from "./types";

const TOKEN_USD_FLOOR = 5;
// Multicall3 calldata/response size is bounded by the RPC node's own
// eth_call gas cap, not by us — chunking keeps each call comfortably under
// that regardless of node config. 300 worked fine against PublicNode
// (Base: 0 failures across 2683 tokens) but tripped errors against another
// free RPC on Ethereum mainnet at the same size — smaller batches plus the
// retry in multicallChunkWithRetry are the two mitigations for a free
// provider that turns out to be pickier than expected.
const MULTICALL_CHUNK_SIZE = 150;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

interface RegistryToken {
  contract: string;
  symbol: string;
  decimals: number | null;
  coingecko_id: string | null;
  image_url: string | null;
}

const REGISTRY_PAGE_SIZE = 1000;

// PostgREST caps rows per request (1000 by default) regardless of a
// .limit() above that — a chain with more registered tokens than that
// (most of them, once the registry is populated) would otherwise only ever
// check the first page. The .order() is load-bearing, not cosmetic: without
// a deterministic sort, Postgres doesn't guarantee the same row lands on
// the same page across separate range() calls, and a row that shifts
// between pages gets returned twice — which is exactly what caused "ON
// CONFLICT DO UPDATE command cannot affect row a second time" in
// saveDecimals below the first time this ran against Ethereum's 5,800+ row
// registry.
//
// The first page's exact `count` tells us how many more pages exist up
// front, so the rest are fetched concurrently instead of one page at a
// time in a loop — this was pure sequential latency on every single sync
// for a large registry (Ethereum: ~6 round-trips end to end before
// Multicall3 even starts), unrelated to anything on-chain and easy to
// parallelize since every page is an independent, already-known range.
async function getRegisteredTokens(chainId: string): Promise<RegistryToken[]> {
  const { data: firstPage, error: firstError, count } = await portfolioDb()
    .from("token_registry")
    .select("contract, symbol, decimals, coingecko_id, image_url", { count: "exact" })
    .eq("chain_id", chainId)
    .order("contract")
    .range(0, REGISTRY_PAGE_SIZE - 1);
  if (firstError) throw new Error(`Failed to load token_registry(${chainId}): ${firstError.message}`);

  const all: RegistryToken[] = [...(firstPage as RegistryToken[])];
  const remainingPages = count && count > REGISTRY_PAGE_SIZE ? Math.ceil((count - REGISTRY_PAGE_SIZE) / REGISTRY_PAGE_SIZE) : 0;

  if (remainingPages > 0) {
    const pages = await mapWithConcurrency(
      Array.from({ length: remainingPages }, (_, i) => i + 1),
      5,
      async (pageIndex) => {
        const from = pageIndex * REGISTRY_PAGE_SIZE;
        const { data, error } = await portfolioDb()
          .from("token_registry")
          .select("contract, symbol, decimals, coingecko_id, image_url")
          .eq("chain_id", chainId)
          .order("contract")
          .range(from, from + REGISTRY_PAGE_SIZE - 1);
        if (error) throw new Error(`Failed to load token_registry(${chainId}) page ${pageIndex}: ${error.message}`);
        return data as RegistryToken[];
      },
    );
    all.push(...pages.flat());
  }

  return all;
}

async function saveDecimals(chainId: string, rows: { contract: string; symbol: string; decimals: number }[]) {
  // Postgres' ON CONFLICT can't touch the same row twice within a single
  // upsert statement — dedupe by contract regardless of how a caller built
  // this list, since getRegisteredTokens's ordering fix addresses the one
  // known cause but this is cheap, unconditional insurance against that
  // whole class of error.
  const deduped = [...new Map(rows.map((r) => [r.contract, r])).values()];

  for (let i = 0; i < deduped.length; i += 1000) {
    const chunk = deduped.slice(i, i + 1000).map((r) => ({ chain_id: chainId, ...r }));
    const { error } = await portfolioDb()
      .from("token_registry")
      .upsert(chunk, { onConflict: "chain_id,contract" });
    if (error) throw new Error(`Failed to save decimals(${chainId}): ${error.message}`);
  }
}

// `symbol` has to be included even though this never changes it: Postgres
// validates NOT NULL on the row an upsert would insert even when a
// conflict is found and the actual write ends up being the DO UPDATE
// branch instead — confirmed the hard way, this always threw without it.
// Doesn't touch decimals/coingecko_id, matching saveDecimals' approach.
async function saveImageUrls(
  chainId: string,
  rows: { contract: string; symbol: string; image_url: string }[],
) {
  const deduped = [...new Map(rows.map((r) => [r.contract, r])).values()];
  for (let i = 0; i < deduped.length; i += 1000) {
    const chunk = deduped.slice(i, i + 1000).map((r) => ({ chain_id: chainId, ...r }));
    const { error } = await portfolioDb()
      .from("token_registry")
      .upsert(chunk, { onConflict: "chain_id,contract" });
    if (error) throw new Error(`Failed to save image_url(${chainId}): ${error.message}`);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A chain with a large registry (Ethereum: 5800+ tokens) needs ~40 chunked
// multicall calls. Firing all of them at once (Promise.all) is what caused
// most of them to fail in practice against more than one free RPC provider
// — free tiers rate-limit on concurrent/burst request volume, not just
// total volume. Capping how many chunk requests are in flight at once fixed
// it without needing yet another provider swap.
const CHUNK_CONCURRENCY = 5;

// viem's multicall() return type is generic over the contracts array in a
// way that fights being wrapped in a small reusable helper — pragmatically
// typed as `any` here (same spirit as the `as unknown as bigint` casts
// elsewhere in this file, all working around the same underlying friction),
// not because the shape is actually unknown: every element is always
// `{status:'success', result} | {status:'failure', error}`.
//
// A free public RPC failing a handful of calls in an otherwise-successful
// batch (seen in practice: transient errors on a fraction of a chunk, not
// the whole chunk) must never be silently read as "balance is zero" — that
// would be exactly the "missing coerced into zero" bug this codebase is
// built around never doing (see valuation.ts's top comment). Retries the
// whole chunk up to `attempts` times; whatever's still failing afterward is
// returned as-is so the caller can surface it rather than hide it.
async function multicallChunkWithRetry(
  client: ReturnType<typeof createPublicClient>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contracts: any[],
  attempts = 3,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let results: any[] = await client.multicall({ multicallAddress: MULTICALL3_ADDRESS, contracts });

  for (
    let attempt = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attempt < attempts && results.some((r: any) => r.status === "failure");
    attempt++
  ) {
    await sleep(500 * attempt);
    const retryIndexes = results
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any, i: number) => (r.status === "failure" ? i : -1))
      .filter((i) => i !== -1);
    const retryResults = await client.multicall({
      multicallAddress: MULTICALL3_ADDRESS,
      contracts: retryIndexes.map((i) => contracts[i]),
    });
    results = [...results];
    retryIndexes.forEach((originalIndex, j) => {
      results[originalIndex] = retryResults[j];
    });
  }

  return results;
}

/**
 * Every registered token's balance for this address on one chain, read
 * directly on-chain via Multicall3 (no indexer, no rate limit tied to a
 * third-party's per-IP policy). Tokens the registry knows about but that
 * CoinGecko has no live price for are deliberately dropped, not included
 * as "unpriced" — see the note in evm.ts for why (ticker-collision safety:
 * everything here already has verified CoinGecko metadata, so "no price"
 * mostly means thinly-traded/worthless, unlike Jupiter's raw SPL balances
 * which can be totally unknown tokens worth surfacing).
 */
export interface ChainHoldingsResult {
  holdings: AdapterHolding[];
  /** Balance checks that still failed after retries — NOT the same as a
   * confirmed zero balance, and deliberately not silently treated as one.
   * A nonzero count here means this chain's holdings may be
   * under-reported, and the caller should say so, not hide it. */
  unverifiedCount: number;
}

export async function fetchChainHoldings(chain: EvmChain, address: Address): Promise<ChainHoldingsResult> {
  const tokens = await getRegisteredTokens(chain.id);
  const client = createPublicClient({ transport: http(chain.rpc) });

  const nativeBalancePromise = client.getBalance({ address });

  const balanceResults = (
    await mapWithConcurrency(chunk(tokens, MULTICALL_CHUNK_SIZE), CHUNK_CONCURRENCY, (batch) =>
      multicallChunkWithRetry(
        client,
        batch.map((t) => ({
          address: t.contract as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        })),
      ),
    )
  ).flat();

  const unverified = balanceResults.filter((r) => r.status === "failure").length;

  const held = tokens
    .map((t, i) => ({ token: t, result: balanceResults[i] }))
    .filter(
      (x) => x.result.status === "success" && (x.result.result as unknown as bigint) > BigInt(0),
    );

  // Fetch decimals only for held tokens the registry doesn't already know
  // the decimals for — decimals never change, so this cost is paid once
  // per token, ever.
  const needsDecimals = held.filter((x) => x.token.decimals === null);
  if (needsDecimals.length > 0) {
    const decimalsResults = (
      await mapWithConcurrency(
        chunk(needsDecimals, MULTICALL_CHUNK_SIZE),
        CHUNK_CONCURRENCY,
        (batch) =>
          multicallChunkWithRetry(
            client,
            batch.map((x) => ({
              address: x.token.contract as Address,
              abi: ERC20_ABI,
              functionName: "decimals",
            })),
          ),
      )
    ).flat();

    const toSave: { contract: string; symbol: string; decimals: number }[] = [];
    for (let i = 0; i < needsDecimals.length; i++) {
      const r = decimalsResults[i];
      if (r.status === "success") {
        const decimals = r.result as unknown as number;
        needsDecimals[i].token.decimals = decimals;
        toSave.push({
          contract: needsDecimals[i].token.contract,
          symbol: needsDecimals[i].token.symbol,
          decimals,
        });
      }
    }
    if (toSave.length > 0) await saveDecimals(chain.id, toSave);
  }

  const priceable = held.filter((x) => x.token.decimals !== null);
  const prices = await fetchTokenPrices(
    chain.coingeckoPlatform,
    priceable.map((x) => x.token.contract),
  );

  const included: { token: RegistryToken; qty: number; usd: number }[] = [];
  for (const { token, result } of priceable) {
    const price = prices.get(token.contract.toLowerCase());
    if (price === undefined) continue; // no live price — dropped, see doc comment above
    const qty = Number(formatUnits(result.result as unknown as bigint, token.decimals!));
    const usd = qty * price;
    if (usd <= TOKEN_USD_FLOOR) continue;
    included.push({ token, qty, usd });
  }

  const nativeBalance = await nativeBalancePromise;
  let native: { qty: number; usd: number } | null = null;
  if (nativeBalance > BigInt(0)) {
    const nativePrice = await fetchNativePrice(chain.nativeCoingeckoId);
    if (nativePrice !== null) {
      const qty = Number(formatUnits(nativeBalance, 18));
      const usd = qty * nativePrice;
      if (usd > TOKEN_USD_FLOOR) native = { qty, usd };
    }
  }

  // Logos, batched: only for tokens actually ending up in `holdings` (not
  // every registered token) and only those token_registry doesn't already
  // have a cached image_url for — see saveImageUrls above. Native tokens
  // (no token_registry row to cache against) are always re-fetched fresh;
  // there are only ~15 distinct native ids across every configured chain,
  // cheap enough not to need a cache table of its own.
  //
  // Wrapped so icon fetching/caching can never take down this chain's real
  // balance data — a failure here (CoinGecko hiccup, a save error) just
  // means this sync's holdings render without icons, not that the chain
  // gets reported as failed and its holdings dropped. Learned the hard way:
  // an earlier bug in saveImageUrls threw on every call, which silently
  // wiped real holdings via the per-chain failure path in
  // fetchEvmChainsHoldings before this try/catch existed.
  let fetchedImages = new Map<string, string>();
  try {
    const missingImageIds = new Set<string>();
    for (const { token } of included) {
      if (!token.image_url && token.coingecko_id) missingImageIds.add(token.coingecko_id);
    }
    if (native) missingImageIds.add(chain.nativeCoingeckoId);

    if (missingImageIds.size > 0) fetchedImages = await fetchTokenImages([...missingImageIds]);

    const toCache = included
      .filter(({ token }) => !token.image_url && token.coingecko_id && fetchedImages.has(token.coingecko_id))
      .map(({ token }) => ({
        contract: token.contract,
        symbol: token.symbol,
        image_url: fetchedImages.get(token.coingecko_id!)!,
      }));
    if (toCache.length > 0) await saveImageUrls(chain.id, toCache);
  } catch {
    // Icons are cosmetic — swallow and continue with whatever cached
    // image_urls token_registry already had (fetchedImages may be partially
    // populated above; that's fine, imageFor() below falls back to null).
  }

  function imageFor(token: RegistryToken): string | null {
    return token.image_url ?? (token.coingecko_id ? (fetchedImages.get(token.coingecko_id) ?? null) : null);
  }

  const holdings: AdapterHolding[] = included.map(({ token, qty, usd }) => ({
    ticker: token.symbol,
    qty,
    usd_override: usd,
    contract: token.contract,
    category: "token",
    chain: chain.id,
    icon_url: imageFor(token),
  }));

  if (native) {
    holdings.push({
      ticker: chain.nativeSymbol,
      qty: native.qty,
      usd_override: native.usd,
      contract: null,
      category: "token",
      chain: chain.id,
      icon_url: fetchedImages.get(chain.nativeCoingeckoId) ?? null,
    });
  }

  return { holdings, unverifiedCount: unverified };
}

export interface EvmChainsResult {
  holdings: AdapterHolding[];
  /** Chains that either errored outright, or completed with one or more
   * balance checks still unverified after retries (see
   * ChainHoldingsResult.unverifiedCount) — either way, a reason this
   * chain's holdings might be incomplete, surfaced rather than hidden. One
   * flaky chain never discards another chain's successfully-read
   * balances. */
  failedChains: { chainId: string; error: string }[];
}

type ChainOutcome =
  | { chainId: string; ok: true; holdings: AdapterHolding[]; unverifiedCount: number }
  | { chainId: string; ok: false; error: string };

export async function fetchEvmChainsHoldings(address: Address): Promise<EvmChainsResult> {
  const results: ChainOutcome[] = await Promise.all(
    EVM_CHAINS.map(async (chain): Promise<ChainOutcome> => {
      try {
        const { holdings, unverifiedCount } = await fetchChainHoldings(chain, address);
        return { chainId: chain.id, ok: true, holdings, unverifiedCount };
      } catch (e) {
        return { chainId: chain.id, ok: false, error: (e as Error).message };
      }
    }),
  );

  const holdings = results.flatMap((r) => (r.ok ? r.holdings : []));
  const failedChains = [
    ...results.filter((r) => !r.ok).map((r) => ({ chainId: r.chainId, error: r.error })),
    ...results
      .filter((r) => r.ok && r.unverifiedCount > 0)
      .map((r) => ({
        chainId: r.chainId,
        error: `${(r as { unverifiedCount: number }).unverifiedCount} balance check(s) unverified after retries`,
      })),
  ];

  return { holdings, failedChains };
}

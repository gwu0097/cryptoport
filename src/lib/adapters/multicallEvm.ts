import "server-only";
import {
  createPublicClient,
  http,
  fallback,
  formatUnits,
  isAddress,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Address,
} from "viem";
import { EVM_CHAINS, MULTICALL3_ADDRESS, type EvmChain } from "./evmChains";
import { fetchTokenPrices, fetchTokenImages, fetchMarketStatsByIds } from "./coingecko";
import { mapWithConcurrency } from "./http";
import { serviceDb } from "../supabase";
import { upsertTokenRegistry } from "./tokenRegistry";
import type { AdapterHolding } from "./types";
import type { KeepScope } from "../carryForward";
import { splitByFreshness, SYNC_PRICE_MAX_AGE_MS } from "../priceCache";
import { cachedCoinPrices } from "./coinCache";

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
  // Sync-time price cache (priceCache.ts): the last CoinGecko price and when
  // it was fetched (price_usd null + price_at set = "CoinGecko had none").
  price_usd: number | string | null;
  price_at: string | null;
  change_24h_pct: number | string | null;
  market_cap: number | string | null;
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
  const { data: firstPage, error: firstError, count } = await serviceDb()
    .from("token_registry")
    .select("contract, symbol, decimals, coingecko_id, image_url, price_usd, price_at, change_24h_pct, market_cap", { count: "exact" })
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
        const { data, error } = await serviceDb()
          .from("token_registry")
          .select("contract, symbol, decimals, coingecko_id, image_url, price_usd, price_at, change_24h_pct, market_cap")
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
  await upsertTokenRegistry(rows.map((r) => ({ chain_id: chainId, ...r })));
}

// Doesn't touch decimals/coingecko_id, matching saveDecimals' approach —
// upsertTokenRegistry only ever writes the columns given in each row.
async function saveImageUrls(
  chainId: string,
  rows: { contract: string; symbol: string; image_url: string }[],
) {
  await upsertTokenRegistry(rows.map((r) => ({ chain_id: chainId, ...r })));
}

// Unlike decimals/images (fetched once, cached forever), these stats are
// volatile — written on every sync/refresh that holds the token, same
// lifetime as the price itself. Read back by queries.ts's
// getContractStatsMap, keyed by (chain_id, contract) so the same ticker on
// different chains (or a ticker collision with an unrelated token) never
// cross-contaminates — see the "prices" ticker-keyed table's own
// limitation this sidesteps. change_1h_pct/change_7d_pct/change_30d_pct
// are omitted (not set to null) for a contract whose coingecko_id isn't
// known or wasn't resolvable this cycle — same partial-upsert reasoning as
// prices.ts's own upsertPrice, so a stale-but-real number isn't wiped just
// because this particular refresh couldn't re-fetch it.
async function saveMarketStats(
  chainId: string,
  rows: {
    contract: string;
    symbol: string;
    change_24h_pct?: number | null;
    market_cap?: number | null;
    change_1h_pct?: number | null;
    change_7d_pct?: number | null;
    change_30d_pct?: number | null;
  }[],
) {
  await upsertTokenRegistry(rows.map((r) => ({ chain_id: chainId, ...r })));
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
/** A balanceOf the token contract itself answered with a revert or no data
 * (a dead, self-destructed or non-ERC-20 contract): the same every run, so
 * neither retried nor counted as "unverified" — that count means the RPC
 * didn't answer. 4 on eth, 1 on matic, 7 on bsc showed on every wallet's
 * status on every sync (2026-09-25). */
function isContractFailure(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    !!error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRetryableFailure(r: any): boolean {
  return r.status === "failure" && !isContractFailure(r.error);
}

/** The chain's RPC, plus its fallbacks when it has any (see
 * EvmChain.fallbackRpcs): a request the primary errors or times out on goes
 * to the next one. */
function evmTransport(chain: EvmChain) {
  return chain.fallbackRpcs?.length ? fallback([chain.rpc, ...chain.fallbackRpcs].map((url) => http(url))) : http(chain.rpc);
}

/** Whether a chain has Multicall3 at the standard address — Merlin doesn't,
 * so every aggregate3 there "returned no data" and no Merlin token balance
 * was ever read (2026-09-25). Checked once per chain per server instance. */
const multicallAvailable = new Map<string, Promise<boolean>>();
function hasMulticall3(chainId: string, client: ReturnType<typeof createPublicClient>): Promise<boolean> {
  let p = multicallAvailable.get(chainId);
  if (!p) {
    p = client
      .getCode({ address: MULTICALL3_ADDRESS })
      .then((code) => !!code && code !== "0x")
      .catch(() => {
        multicallAvailable.delete(chainId); // unknown: ask again next time
        return true;
      });
    multicallAvailable.set(chainId, p);
  }
  return p;
}

/** Same result shape as a multicall chunk, one eth_call per token — for a
 * chain without Multicall3. */
async function balanceOfEach(
  client: ReturnType<typeof createPublicClient>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contracts: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  return mapWithConcurrency(contracts, 5, async (c) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return { status: "success", result: await client.readContract(c) };
      } catch (error) {
        if (isContractFailure(error) || attempt >= 2) return { status: "failure", error };
        await sleep(500 * (attempt + 1));
      }
    }
  });
}

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
    attempt < attempts && results.some((r: any) => isRetryableFailure(r));
    attempt++
  ) {
    await sleep(500 * attempt);
    const retryIndexes = results
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any, i: number) => (isRetryableFailure(r) ? i : -1))
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
  /** Set when CoinGecko couldn't be reached for this chain's token prices
   * (a 429 that outlasted retries). Tokens can't be listed then — a live
   * price is the spam filter above — but the native balance still is. */
  priceError: string | null;
  /** The (lowercase) contracts behind unverifiedCount — their previous rows
   * are kept (see carryForward.ts) rather than dropped as if sold. */
  unverifiedContracts: string[];
}

export async function fetchChainHoldings(chain: EvmChain, address: Address): Promise<ChainHoldingsResult> {
  // Real, reported bug (confirmed live via a real wallet's holdings, exact
  // qty match on both sides): some chains' own CoinGecko coins/list entry
  // for their native gas token ALSO carries a contract address on that
  // same chain — Mantle's is a 0xdead...0000 sentinel, Celo's native CELO
  // has genuinely always been a real, first-class ERC-20 contract
  // alongside being the gas token. refreshTokenRegistry (coingecko.ts)
  // ingests every (chain, contract) pair CoinGecko reports for a platform
  // without knowing this, so token_registry ends up with a contract row
  // whose coingecko_id is the SAME asset the separate nativeBalancePromise
  // check below already covers — Multicall3's balanceOf on that address
  // returns the same balance a second time, doubling that holding's value
  // in every total. Filtered out by coingecko_id (the real signal that two
  // rows represent the same asset), not by hardcoding the specific
  // sentinel addresses seen so far — that would miss this pattern on any
  // other chain with the same CoinGecko-data quirk.
  // isAddress: CoinGecko's platform lists carry some malformed contract
  // strings (28 on bsc, 14 on sei, 2026-09-25) no balance call can take.
  const tokens = (await getRegisteredTokens(chain.id)).filter(
    (t) => t.coingecko_id !== chain.nativeCoingeckoId && isAddress(t.contract, { strict: false }),
  );
  const client = createPublicClient({ transport: evmTransport(chain) });

  const nativeBalancePromise = client.getBalance({ address });
  const useMulticall = await hasMulticall3(chain.id, client);

  const balanceResults = (
    await mapWithConcurrency(chunk(tokens, MULTICALL_CHUNK_SIZE), CHUNK_CONCURRENCY, (batch) => {
      const calls = batch.map((t) => ({
        address: t.contract as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      }));
      return useMulticall ? multicallChunkWithRetry(client, calls) : balanceOfEach(client, calls);
    })
  ).flat();

  const unverifiedContracts = tokens.filter((_, i) => isRetryableFailure(balanceResults[i])).map((t) => t.contract.toLowerCase());
  const unverified = unverifiedContracts.length;

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
  // Prices another wallet's sync fetched in the last few minutes are reused
  // (token_registry.price_usd/price_at, see priceCache.ts); only the rest
  // are asked of CoinGecko — a Sync all prices each chain about once.
  // A failed price call is "no answer", not "no price": it used to throw
  // and take this chain's native balance down with it (2026-09-24).
  const now = Date.now();
  const { fresh, stale } = splitByFreshness(priceable, (x) => x.token.price_at, now, SYNC_PRICE_MAX_AGE_MS);
  const prices = new Map<string, { usd: number; change24h: number | null; marketCap: number | null }>();
  for (const { token } of fresh) {
    if (token.price_usd === null) continue; // cached "no CoinGecko price"
    prices.set(token.contract.toLowerCase(), {
      usd: Number(token.price_usd),
      change24h: token.change_24h_pct === null ? null : Number(token.change_24h_pct),
      marketCap: token.market_cap === null ? null : Number(token.market_cap),
    });
  }
  let priceError: string | null = null;
  if (stale.length > 0) {
    const live = await fetchTokenPrices(
      chain.coingeckoPlatform,
      stale.map((x) => x.token.contract),
    ).catch((e: Error) => {
      priceError = e.message;
      return null;
    });
    if (live) {
      for (const [contract, price] of live) prices.set(contract, price);
      // Cache this answer for the next wallet (null = CoinGecko had none).
      await upsertTokenRegistry(
        stale.map(({ token }) => ({
          chain_id: chain.id,
          contract: token.contract,
          symbol: token.symbol,
          price_usd: live.get(token.contract.toLowerCase())?.usd ?? null,
          price_at: new Date(now).toISOString(),
        })),
      ).catch((e: Error) => console.warn(`[multicallEvm] price cache save (${chain.id}) failed: ${e.message}`));
    }
  }

  const included: { token: RegistryToken; qty: number; usd: number; change24h: number | null; marketCap: number | null }[] = [];
  for (const { token, result } of priceable) {
    const price = prices.get(token.contract.toLowerCase());
    if (price === undefined) continue; // no live price — dropped, see doc comment above
    const qty = Number(formatUnits(result.result as unknown as bigint, token.decimals!));
    const usd = qty * price.usd;
    if (usd <= TOKEN_USD_FLOOR) continue;
    included.push({ token, qty, usd, change24h: price.change24h, marketCap: price.marketCap });
  }

  // Volatile, unlike decimals/images above — written every sync regardless
  // of whether token_registry already had a value, so a token's 24h change
  // never goes stale between refreshTokenRegistry runs.
  try {
    const changeRows = included.map(({ token, change24h, marketCap }) => ({
      contract: token.contract,
      symbol: token.symbol,
      change_24h_pct: change24h,
      market_cap: marketCap,
    }));
    if (changeRows.length > 0) await saveMarketStats(chain.id, changeRows);
  } catch {
    // Same "cosmetic, never take down real balance data" reasoning as the
    // icon try/catch below.
  }

  const nativeBalance = await nativeBalancePromise;
  let native: { qty: number; usd: number | null } | null = null;
  if (nativeBalance > BigInt(0)) {
    // No price (none listed, or CoinGecko unreachable) keeps the balance,
    // unpriced; Refresh prices' EVM lane fills it in. It used to drop the
    // row entirely.
    const nativePrice = await cachedCoinPrices([chain.nativeCoingeckoId])
      .then((m) => m.get(chain.nativeCoingeckoId) ?? null)
      .catch(() => null);
    const qty = Number(formatUnits(nativeBalance, 18));
    const usd = nativePrice === null ? null : qty * nativePrice;
    // TOKEN_USD_FLOOR deliberately does NOT apply here, unlike the ERC20
    // check above — that floor exists to filter spam/copycat tokens with
    // fake wash-traded liquidity, a risk that's structurally impossible
    // for a chain's own native currency (there's exactly one RON per
    // Ronin wallet, not an unbounded set of spoofable native-look-alikes).
    // Real bug, caught live: a wallet's genuine 54 RON (~$2.89) balance
    // was silently dropped by this floor, with no warning surfaced
    // anywhere — a small real balance is exactly the "unknown/small
    // still real data" case CLAUDE.md's Data Correctness rule protects.
    native = { qty, usd };
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

  return { holdings, unverifiedCount: unverified, priceError, unverifiedContracts };
}

export interface EvmChainsResult {
  holdings: AdapterHolding[];
  /** Chains that either errored outright, or completed with one or more
   * balance checks still unverified after retries (see
   * ChainHoldingsResult.unverifiedCount) — either way, a reason this
   * chain's holdings might be incomplete, surfaced rather than hidden. One
   * flaky chain never discards another chain's successfully-read
   * balances. */
  failedChains: {
    chainId: string;
    error: string;
    /** true = this chain's whole fetch threw (network down, RPC
     * unreachable) — real grounds to distrust the overall result. false =
     * the chain completed fine, just with some individual balance-of
     * calls unverified after retries (see evm.ts's zero-holdings guard for
     * why this distinction matters: a wallet that's genuinely empty
     * everywhere shouldn't get treated as "everything failed" just
     * because one unrelated chain had a flaky token check). */
    hard: boolean;
  }[];
  /** Rows the failures above leave unanswered — kept from the last sync. */
  keep: KeepScope[];
}

type ChainOutcome =
  | ({ chainId: string; ok: true } & ChainHoldingsResult)
  | { chainId: string; ok: false; error: string };

export async function fetchEvmChainsHoldings(address: Address): Promise<EvmChainsResult> {
  const results: ChainOutcome[] = await Promise.all(
    EVM_CHAINS.map(async (chain): Promise<ChainOutcome> => {
      try {
        return { chainId: chain.id, ok: true, ...(await fetchChainHoldings(chain, address)) };
      } catch (e) {
        return { chainId: chain.id, ok: false, error: (e as Error).message };
      }
    }),
  );

  const holdings = results.flatMap((r) => (r.ok ? r.holdings : []));
  const failedChains = [
    ...results.filter((r) => !r.ok).map((r) => ({ chainId: r.chainId, error: r.error, hard: true })),
    ...results
      .filter((r) => r.ok && r.unverifiedCount > 0)
      .map((r) => ({
        chainId: r.chainId,
        error: `${(r as { unverifiedCount: number }).unverifiedCount} balance check(s) unverified after retries`,
        hard: false,
      })),
    // hard: tokens on this chain weren't listed, so an otherwise-empty
    // result mustn't overwrite the wallet's previous holdings (evm.ts).
    ...results
      .filter((r) => r.ok && r.priceError !== null)
      .map((r) => ({
        chainId: r.chainId,
        error: `token prices unavailable (${(r as { priceError: string }).priceError})`,
        hard: true,
      })),
  ];

  // A chain's own rows are its plain balances (category "token"); staking
  // adapters on the same chain (Axie on ron) have their own scopes in evm.ts.
  const keep: KeepScope[] = [];
  for (const r of results) {
    const id = r.chainId;
    if (!r.ok) {
      keep.push({ label: `${id} balances`, owns: (h) => h.chain === id && h.category === "token" });
      continue;
    }
    if (r.priceError !== null) {
      keep.push({ label: `${id} tokens`, owns: (h) => h.chain === id && h.category === "token" && h.contract !== null });
    } else if (r.unverifiedContracts.length > 0) {
      const set = new Set(r.unverifiedContracts);
      keep.push({ label: `${id} unverified tokens`, owns: (h) => h.chain === id && h.category === "token" && !!h.contract && set.has(h.contract.toLowerCase()) });
    }
  }

  return { holdings, failedChains, keep };
}

interface EvmHoldingRow {
  id: string;
  wallet_id: string;
  ticker: string;
  chain: string;
  contract: string | null;
  qty: number | string | null;
}

/**
 * Re-prices every already-tracked EVM holding (token or native) straight
 * from CoinGecko, using the (chain, contract, qty) already on the holding
 * row — no RPC call, no on-chain balance re-check. Deliberately decoupled
 * from fetchChainHoldings/multicallChunkWithRetry above: "is this price
 * current" and "does this wallet still hold this token" are different
 * questions, and the first one shouldn't have to wait for (or pay the cost
 * of) the second. This is what lets the "Refresh prices" button catch up
 * every EVM holding immediately, the same way it already does for every
 * Coinbase/Jupiter-priced ticker — instead of an EVM token's price and 24h
 * change being stuck until that specific wallet's next full sync. Priced by
 * CoinGecko coin id in one batched call for every chain (see below).
 */
export async function refreshEvmHoldingPrices(): Promise<{ ticker: string; ok: boolean; error?: string }[]> {
  // No active-wallet filter — same "cheap and global, don't bother
  // scoping" choice prices.ts's getDistinctHoldingTickers already makes for
  // the ticker-keyed refresh.
  const { data, error } = await serviceDb()
    .from("holdings")
    .select("id, wallet_id, ticker, chain, contract, qty")
    .eq("source", "auto")
    .not("chain", "is", null);
  if (error) throw new Error(`Failed to load EVM holdings: ${error.message}`);

  const rows = (data as EvmHoldingRow[]).filter((r) => EVM_CHAINS.some((c) => c.id === r.chain));
  if (rows.length === 0) return [];

  // Every held contract's CoinGecko coin id (token_registry, from
  // CoinGecko's own contract -> coin mapping — never a ticker guess).
  const contractRows = rows.filter((r): r is EvmHoldingRow & { contract: string } => r.contract !== null);
  const key = (chain: string, contract: string) => `${chain}|${contract.toLowerCase()}`;
  const idByKey = new Map<string, string>();
  if (contractRows.length > 0) {
    const { data: reg, error: regError } = await serviceDb()
      .from("token_registry")
      .select("chain_id, contract, coingecko_id")
      .in("chain_id", [...new Set(contractRows.map((r) => r.chain))])
      .in("contract", [...new Set(contractRows.map((r) => r.contract))])
      .not("coingecko_id", "is", null);
    if (regError) throw new Error(`Failed to load token ids: ${regError.message}`);
    for (const r of reg as { chain_id: string; contract: string; coingecko_id: string }[]) idByKey.set(key(r.chain_id, r.contract), r.coingecko_id);
  }
  const nativeIdOf = (chainId: string) => EVM_CHAINS.find((c) => c.id === chainId)!.nativeCoingeckoId;

  // One batched /coins/markets call (250 ids each) prices every held token
  // and native coin on every chain at once, with its 24h/1h/7d/30d change
  // and market cap. It used to be a contract-price call plus a market-stats
  // call per chain plus a native call per coin — ~45 calls, ~2 minutes once
  // paced to CoinGecko's per-minute limit (2026-09-25); now ~1.
  const ids = new Set<string>(idByKey.values());
  for (const r of rows) if (r.contract === null) ids.add(nativeIdOf(r.chain));
  const stats = await fetchMarketStatsByIds([...ids]);

  // A held contract with no CoinGecko id (none today) falls back to the
  // per-chain contract-price endpoint.
  const noId = contractRows.filter((r) => !idByKey.has(key(r.chain, r.contract)));
  const byContract = new Map<string, { usd: number; change24h: number | null; marketCap: number | null }>();
  for (const [chainId, chainRows] of groupBy(noId, (r) => r.chain)) {
    const chain = EVM_CHAINS.find((c) => c.id === chainId)!;
    const prices = await fetchTokenPrices(chain.coingeckoPlatform, chainRows.map((r) => r.contract)).catch(() => null);
    for (const [contract, price] of prices ?? []) byContract.set(key(chainId, contract), price);
  }

  const results: { ticker: string; ok: boolean; error?: string }[] = [];
  const upserts: { id: string; wallet_id: string; ticker: string; source: "auto"; usd_override: number }[] = [];
  const statRows = new Map<string, { contract: string; symbol: string; [k: string]: unknown }[]>();
  for (const row of rows) {
    const coinId = row.contract === null ? nativeIdOf(row.chain) : idByKey.get(key(row.chain, row.contract));
    const coin = coinId ? stats.get(coinId) : undefined;
    const price = coin ?? (row.contract ? byContract.get(key(row.chain, row.contract)) : undefined);
    if (!price) {
      results.push({ ticker: row.ticker, ok: false, error: `No CoinGecko price for this ${row.contract ? "contract" : "native asset"}.` });
      continue;
    }
    const qty = Number(row.qty);
    if (!Number.isFinite(qty)) {
      results.push({ ticker: row.ticker, ok: false, error: "Holding has no parseable quantity." });
      continue;
    }
    upserts.push({ id: row.id, wallet_id: row.wallet_id, ticker: row.ticker, source: "auto", usd_override: qty * price.usd });
    if (row.contract) {
      const list = statRows.get(row.chain) ?? [];
      list.push({
        contract: row.contract,
        symbol: row.ticker,
        change_24h_pct: price.change24h,
        market_cap: price.marketCap,
        ...(coin ? { change_1h_pct: coin.change1h, change_7d_pct: coin.change7d, change_30d_pct: coin.change30d } : {}),
      });
      statRows.set(row.chain, list);
    }
  }

  try {
    for (let i = 0; i < upserts.length; i += 1000) {
      const { error: upsertError } = await serviceDb().from("holdings").upsert(upserts.slice(i, i + 1000), { onConflict: "id" });
      if (upsertError) throw new Error(upsertError.message);
    }
    for (const u of upserts) results.push({ ticker: u.ticker, ok: true });
  } catch (e) {
    for (const u of upserts) results.push({ ticker: u.ticker, ok: false, error: (e as Error).message });
    return results;
  }
  // Cosmetic stats (24h/1h/7d/30d, market cap): a failed write never fails
  // the prices already saved above.
  for (const [chainId, list] of statRows) await saveMarketStats(chainId, list).catch(() => {});
  return results;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(keyOf(item), [...(out.get(keyOf(item)) ?? []), item]);
  return out;
}

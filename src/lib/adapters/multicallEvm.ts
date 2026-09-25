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
import { fetchTokenImages } from "./coingecko";
import { mapWithConcurrency } from "./http";
import { serviceDb } from "../supabase";
import { upsertTokenRegistry } from "./tokenRegistry";
import type { AdapterHolding } from "./types";
import type { KeepScope } from "../carryForward";
import { ensureAssetPrices, readAssetPrices } from "./assetPrices";

// Sub-cent dust only. The spam protection is that CoinGecko must list and price
// the token; a $5 floor on top of that dropped real small holdings (ENA,
// VELO, ALT, weETH… — $26 on one wallet vs DeBank/Zerion, 2026-09-25), and
// the owner wants every legitimate token captured, however small.
const TOKEN_USD_FLOOR = 0.01;
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
  const { data: firstPage, error: firstError, count } = await serviceDb()
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
        const { data, error } = await serviceDb()
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
export function evmTransport(chain: EvmChain) {
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

interface ChainScan {
  chain: EvmChain;
  held: { token: RegistryToken; qty: number }[];
  nativeQty: number | null;
  unverifiedCount: number;
  unverifiedContracts: string[];
}

export async function fetchChainHoldings(chain: EvmChain, address: Address): Promise<ChainScan> {
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

  const priceable = held
    .filter((x) => x.token.decimals !== null)
    .map(({ token, result }) => ({ token, qty: Number(formatUnits(result.result as unknown as bigint, token.decimals!)) }));
  const nativeBalance = await nativeBalancePromise;
  return {
    chain,
    held: priceable,
    nativeQty: nativeBalance > BigInt(0) ? Number(formatUnits(nativeBalance, 18)) : null,
    unverifiedCount: unverified,
    unverifiedContracts,
  };
}

/**
 * Turns every chain's scanned balances into holdings with ONE pricing step
 * for the whole wallet (docs/pricing/PLAN.md): every held coin's id and the
 * chains' native coins are priced through asset_prices (ensureAssetPrices
 * fetches only coins not priced in the last few minutes — another wallet's
 * sync, or Refresh prices, usually already has them). It used to price per
 * chain per wallet, ~20 CoinGecko calls a wallet.
 *
 * The spam filter: a token is listed only if CoinGecko prices it (and it's
 * worth more than sub-cent dust, TOKEN_USD_FLOOR).
 * Native coins are always listed (priced or not). If the pricing call fails,
 * coins keep their last stored price; a chain holding tokens that ended up
 * with no price at all is reported (priceError) so its previous rows stay.
 */
async function priceScans(scans: ChainScan[]): Promise<Map<string, ChainHoldingsResult>> {
  const ids = new Set<string>();
  for (const s of scans) {
    for (const { token } of s.held) if (token.coingecko_id) ids.add(token.coingecko_id);
    if (s.nativeQty !== null) ids.add(s.chain.nativeCoingeckoId);
  }
  let pricingError: string | null = null;
  await ensureAssetPrices([...ids], "sync").catch((e: Error) => {
    pricingError = e.message;
  });
  const prices = await readAssetPrices([...ids]);

  const images = new Map<string, string>();
  const missingImageIds = new Set<string>();
  for (const s of scans) {
    for (const { token } of s.held) if (!token.image_url && token.coingecko_id && prices.has(token.coingecko_id)) missingImageIds.add(token.coingecko_id);
    if (s.nativeQty !== null) missingImageIds.add(s.chain.nativeCoingeckoId);
  }
  // Logos are cosmetic (and cached for good in coin_cache): never fail a sync.
  if (missingImageIds.size > 0) {
    for (const [id, url] of await fetchTokenImages([...missingImageIds]).catch(() => new Map<string, string>())) images.set(id, url);
  }

  const out = new Map<string, ChainHoldingsResult>();
  for (const s of scans) {
    const holdings: AdapterHolding[] = [];
    let unpriced = 0;
    const toCache: { contract: string; symbol: string; image_url: string }[] = [];
    for (const { token, qty } of s.held) {
      const price = token.coingecko_id ? prices.get(token.coingecko_id) : undefined;
      if (price === undefined) {
        unpriced++;
        continue; // not on CoinGecko (or never priced yet): not listed — the spam filter
      }
      const usd = qty * price;
      if (usd <= TOKEN_USD_FLOOR) continue;
      const image = token.image_url ?? (token.coingecko_id ? (images.get(token.coingecko_id) ?? null) : null);
      if (!token.image_url && image) toCache.push({ contract: token.contract, symbol: token.symbol, image_url: image });
      // Valued from asset_prices by its key at read time; no stored copy.
      holdings.push({ ticker: token.symbol, qty, usd_override: null, contract: token.contract, category: "token", chain: s.chain.id, icon_url: image });
    }
    if (s.nativeQty !== null) {
      holdings.push({
        ticker: s.chain.nativeSymbol,
        qty: s.nativeQty,
        usd_override: null,
        contract: null,
        category: "token",
        chain: s.chain.id,
        icon_url: images.get(s.chain.nativeCoingeckoId) ?? null,
      });
    }
    if (toCache.length > 0) await saveImageUrls(s.chain.id, toCache).catch(() => {});
    out.set(s.chain.id, {
      holdings,
      unverifiedCount: s.unverifiedCount,
      unverifiedContracts: s.unverifiedContracts,
      priceError: pricingError && unpriced > 0 ? pricingError : null,
    });
  }
  return out;
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
  const scans = await Promise.all(
    EVM_CHAINS.map(async (chain): Promise<ChainScan | { chainId: string; error: string }> => {
      try {
        return await fetchChainHoldings(chain, address);
      } catch (e) {
        return { chainId: chain.id, error: (e as Error).message };
      }
    }),
  );
  const priced = await priceScans(scans.filter((x): x is ChainScan => "held" in x));
  const results: ChainOutcome[] = scans.map((x) =>
    "held" in x ? { chainId: x.chain.id, ok: true as const, ...priced.get(x.chain.id)! } : { chainId: x.chainId, ok: false as const, error: x.error },
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

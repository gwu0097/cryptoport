import "server-only";
import { createPublicClient, http, formatUnits, type Address } from "viem";
import { EVM_CHAINS, MULTICALL3_ADDRESS, type EvmChain } from "./evmChains";
import { fetchNativePrice, fetchTokenPrices } from "./coingecko";
import { portfolioDb } from "../supabase";
import type { AdapterHolding } from "./types";

const TOKEN_USD_FLOOR = 5;
// Multicall3 calldata/response size is bounded by the RPC node's own
// eth_call gas cap, not by us — chunking keeps each call comfortably under
// that regardless of node config.
const MULTICALL_CHUNK_SIZE = 300;

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
}

async function getRegisteredTokens(chainId: string): Promise<RegistryToken[]> {
  const { data, error } = await portfolioDb()
    .from("token_registry")
    .select("contract, symbol, decimals")
    .eq("chain_id", chainId);
  if (error) throw new Error(`Failed to load token_registry(${chainId}): ${error.message}`);
  return data as RegistryToken[];
}

async function saveDecimals(chainId: string, rows: { contract: string; symbol: string; decimals: number }[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000).map((r) => ({ chain_id: chainId, ...r }));
    const { error } = await portfolioDb()
      .from("token_registry")
      .upsert(chunk, { onConflict: "chain_id,contract" });
    if (error) throw new Error(`Failed to save decimals(${chainId}): ${error.message}`);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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
export async function fetchChainHoldings(chain: EvmChain, address: Address): Promise<AdapterHolding[]> {
  const tokens = await getRegisteredTokens(chain.id);
  const client = createPublicClient({ transport: http(chain.rpc) });

  const nativeBalancePromise = client.getBalance({ address });

  const balanceResults = (
    await Promise.all(
      chunk(tokens, MULTICALL_CHUNK_SIZE).map((batch) =>
        client.multicall({
          multicallAddress: MULTICALL3_ADDRESS,
          contracts: batch.map((t) => ({
            address: t.contract as Address,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          })),
        }),
      ),
    )
  ).flat();

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
      await Promise.all(
        chunk(needsDecimals, MULTICALL_CHUNK_SIZE).map((batch) =>
          client.multicall({
            multicallAddress: MULTICALL3_ADDRESS,
            contracts: batch.map((x) => ({
              address: x.token.contract as Address,
              abi: ERC20_ABI,
              functionName: "decimals",
            })),
          }),
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

  const holdings: AdapterHolding[] = [];
  for (const { token, result } of priceable) {
    const price = prices.get(token.contract.toLowerCase());
    if (price === undefined) continue; // no live price — dropped, see doc comment above
    const qty = Number(formatUnits(result.result as unknown as bigint, token.decimals!));
    const usd = qty * price;
    if (usd <= TOKEN_USD_FLOOR) continue;
    holdings.push({ ticker: token.symbol, qty, usd_override: usd, contract: token.contract, category: "token" });
  }

  const nativeBalance = await nativeBalancePromise;
  if (nativeBalance > BigInt(0)) {
    const nativePrice = await fetchNativePrice(chain.nativeCoingeckoId);
    if (nativePrice !== null) {
      const qty = Number(formatUnits(nativeBalance, 18));
      const usd = qty * nativePrice;
      if (usd > TOKEN_USD_FLOOR) {
        holdings.push({
          ticker: chain.nativeSymbol,
          qty,
          usd_override: usd,
          contract: null,
          category: "token",
        });
      }
    }
  }

  return holdings;
}

export async function fetchEvmChainsHoldings(address: Address): Promise<AdapterHolding[]> {
  const results = await Promise.all(EVM_CHAINS.map((chain) => fetchChainHoldings(chain, address)));
  return results.flat();
}

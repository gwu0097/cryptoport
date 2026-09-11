import "server-only";
import { bech32 } from "@scure/base";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

/**
 * Every Cosmos SDK chain exposes the same standard bank-module REST
 * endpoint (`/cosmos/bank/v1beta1/balances/{address}`) on its LCD — this
 * adapter is entirely data-driven per chain, same idea as evmChains.ts:
 * adding another Cosmos SDK chain is a one-line addition here, no other
 * code changes. `id` matches this app's Chain-union wallet.chain value
 * (e.g. "ATOM", "INJ") so dispatch in wallets/actions.ts is a straight
 * lookup, not a chain-specific branch.
 */
export interface CosmosChainConfig {
  id: string;
  name: string;
  /** Bech32 human-readable prefix — used only to sanity-check an address
   * actually belongs to this chain before hitting its LCD. */
  bech32Prefix: string;
  /** Free, keyless LCD REST endpoint (PublicNode, verified live for both
   * chains configured below — same provider already trusted for EVM). */
  lcd: string;
  /** Base-unit denom for the native token (e.g. "uatom", "inj") — the
   * balances response lists every denom the address holds (IBC transfers,
   * tokenfactory denoms, ...); only this one is read, matching the
   * BTC/ADA/EVM-native precedent of native-asset-only scope. */
  denom: string;
  decimals: number;
  nativeCoingeckoId: string;
  nativeSymbol: string;
  /** holding.chain value — must have a matching entry in coingecko.ts's
   * NATIVE_ICON_CHAINS for its chain-group icon to resolve. */
  chainSlug: string;
}

export const COSMOS_CHAINS: CosmosChainConfig[] = [
  {
    id: "ATOM",
    name: "Cosmos Hub",
    bech32Prefix: "cosmos",
    lcd: "https://cosmos-rest.publicnode.com",
    denom: "uatom",
    decimals: 6,
    nativeCoingeckoId: "cosmos",
    nativeSymbol: "ATOM",
    chainSlug: "cosmoshub",
  },
  {
    id: "INJ",
    name: "Injective",
    bech32Prefix: "inj",
    lcd: "https://injective-rest.publicnode.com",
    denom: "inj",
    decimals: 18,
    nativeCoingeckoId: "injective-protocol",
    nativeSymbol: "INJ",
    chainSlug: "injective",
  },
  // Sei is unusual: it's a Cosmos SDK chain with a full EVM execution
  // layer bolted on, so the SAME wallet.chain value ("SEI") is genuinely
  // ambiguous between two entirely different address formats/adapters —
  // an EVM 0x... address (already covered by evmChains.ts's "sei" entry,
  // scanned the same way as any other EVM chain) and this Cosmos-native
  // sei1... address, which is a separate balance the EVM side can't see.
  // Resolved by address format, not by a different chain label — see the
  // "SEI" dispatch in wallets/actions.ts's fetchAdapterHoldings.
  {
    id: "SEI",
    name: "Sei",
    bech32Prefix: "sei",
    lcd: "https://sei-rest.publicnode.com",
    denom: "usei",
    decimals: 6,
    nativeCoingeckoId: "sei-network",
    nativeSymbol: "SEI",
    chainSlug: "sei",
  },
];

export function cosmosChainFor(chainId: string): CosmosChainConfig | undefined {
  return COSMOS_CHAINS.find((c) => c.id === chainId);
}

export function isCosmosAddress(chainId: string, address: string): boolean {
  const cfg = cosmosChainFor(chainId);
  if (!cfg) return false;
  try {
    const { prefix } = bech32.decode(address as `${string}1${string}`, false);
    return prefix === cfg.bech32Prefix;
  } catch {
    return false;
  }
}

interface BalanceRow {
  denom: string;
  amount: string;
}
interface BalancesResponse {
  balances: BalanceRow[];
}

/**
 * A Cosmos SDK wallet only ever has one holding tracked here (the chain's
 * native token) — same scope as bitcoin.ts/cardano.ts, which likewise
 * don't scan for every token a wallet could hold. No caching layer, unlike
 * BTC/ADA: a Cosmos bank-balance lookup is already a single fast REST call
 * given the address directly, nothing to resolve/cache first.
 */
export async function fetchCosmosHoldings(chainId: string, address: string): Promise<AdapterHolding[]> {
  const cfg = cosmosChainFor(chainId);
  if (!cfg) throw new Error(`Unknown Cosmos chain "${chainId}"`);

  const res = await fetchWithRetry(`${cfg.lcd}/cosmos/bank/v1beta1/balances/${address}`);
  if (!res.ok) throw new Error(`${cfg.name} balances failed: HTTP ${res.status}`);
  const body: BalancesResponse = await res.json();
  const raw = body.balances.find((b) => b.denom === cfg.denom);
  if (!raw || raw.amount === "0") return [];

  // formatUnits (bigint-safe) rather than plain Number division — Injective's
  // 18-decimal amounts can exceed Number.MAX_SAFE_INTEGER in base units,
  // same reasoning as the EVM adapter's wei conversions.
  const qty = Number(formatUnits(BigInt(raw.amount), cfg.decimals));
  const images = await fetchTokenImages([cfg.nativeCoingeckoId]).catch(() => new Map<string, string>());

  return [
    {
      ticker: cfg.nativeSymbol,
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: cfg.chainSlug,
      icon_url: images.get(cfg.nativeCoingeckoId) ?? null,
    },
  ];
}

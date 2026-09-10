import "server-only";

/**
 * EVM chains this app can read on-chain balances for, via Multicall3 on a
 * free, keyless public RPC — no API key, no per-wallet vendor rate limit
 * (unlike the Rabby indexer). Every `rpc` URL below was hand-verified
 * (matching `eth_chainId` against the real chain ID) before being added.
 *
 * This list is not exhaustive — it's the ~15 biggest EVM chains by activity,
 * not literally everything Ankr/PublicNode offer. Adding another chain is a
 * one-line addition here (id, name, chainId, a verified public RPC URL) —
 * no other code changes, since the sync pipeline (evmChains.ts ->
 * multicallEvm.ts -> evm.ts) is entirely data-driven per chain.
 */
export interface EvmChain {
  /** Matches this app's existing chain-id vocabulary elsewhere (Rabby's
   * ids) where one exists, for easier cross-referencing — otherwise a
   * short slug. Not the numeric chain ID. */
  id: string;
  name: string;
  chainId: number;
  rpc: string;
  /** CoinGecko's platform id for this chain (e.g. "base",
   * "optimistic-ethereum") — verified against CoinGecko's own
   * /asset_platforms (keyed by chain_identifier, the numeric chain ID, not
   * by guessing slug names). Used to filter coins/list into this chain's
   * token registry and to look up token prices. */
  coingeckoPlatform: string;
  /** CoinGecko coin id for this chain's native/gas token — also from
   * /asset_platforms. Not always what you'd guess: Polygon's is
   * "polygon-ecosystem-token" (POL), not "matic-network". */
  nativeCoingeckoId: string;
  /** Display ticker for the native token — kept separate from
   * nativeCoingeckoId since CoinGecko's coin id and the conventional
   * trading symbol aren't always the same string. */
  nativeSymbol: string;
}

export const EVM_CHAINS: EvmChain[] = [
  {
    id: "eth",
    name: "Ethereum",
    chainId: 1,
    rpc: "https://cloudflare-eth.com",
    coingeckoPlatform: "ethereum",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "base",
    name: "Base",
    chainId: 8453,
    rpc: "https://base-rpc.publicnode.com",
    coingeckoPlatform: "base",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "arb",
    name: "Arbitrum",
    chainId: 42161,
    rpc: "https://arbitrum-one-rpc.publicnode.com",
    coingeckoPlatform: "arbitrum-one",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "op",
    name: "Optimism",
    chainId: 10,
    rpc: "https://optimism-rpc.publicnode.com",
    coingeckoPlatform: "optimistic-ethereum",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "matic",
    name: "Polygon",
    chainId: 137,
    rpc: "https://polygon-bor-rpc.publicnode.com",
    coingeckoPlatform: "polygon-pos",
    nativeCoingeckoId: "polygon-ecosystem-token",
    nativeSymbol: "POL",
  },
  {
    id: "avax",
    name: "Avalanche",
    chainId: 43114,
    rpc: "https://avalanche-c-chain-rpc.publicnode.com",
    coingeckoPlatform: "avalanche",
    nativeCoingeckoId: "avalanche-2",
    nativeSymbol: "AVAX",
  },
  {
    id: "bsc",
    name: "BNB Smart Chain",
    chainId: 56,
    rpc: "https://bsc-rpc.publicnode.com",
    coingeckoPlatform: "binance-smart-chain",
    nativeCoingeckoId: "binancecoin",
    nativeSymbol: "BNB",
  },
  {
    id: "linea",
    name: "Linea",
    chainId: 59144,
    rpc: "https://linea-rpc.publicnode.com",
    coingeckoPlatform: "linea",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "scrl",
    name: "Scroll",
    chainId: 534352,
    rpc: "https://scroll-rpc.publicnode.com",
    coingeckoPlatform: "scroll",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "blast",
    name: "Blast",
    chainId: 81457,
    rpc: "https://blast-rpc.publicnode.com",
    coingeckoPlatform: "blast",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "mnt",
    name: "Mantle",
    chainId: 5000,
    rpc: "https://mantle-rpc.publicnode.com",
    coingeckoPlatform: "mantle",
    nativeCoingeckoId: "mantle",
    nativeSymbol: "MNT",
  },
  {
    id: "taiko",
    name: "Taiko",
    chainId: 167000,
    rpc: "https://taiko-rpc.publicnode.com",
    coingeckoPlatform: "taiko",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "xdai",
    name: "Gnosis Chain",
    chainId: 100,
    rpc: "https://gnosis-rpc.publicnode.com",
    coingeckoPlatform: "xdai",
    nativeCoingeckoId: "xdai",
    nativeSymbol: "XDAI",
  },
  {
    id: "celo",
    name: "Celo",
    chainId: 42220,
    rpc: "https://celo-rpc.publicnode.com",
    coingeckoPlatform: "celo",
    nativeCoingeckoId: "celo",
    nativeSymbol: "CELO",
  },
  {
    id: "opbnb",
    name: "opBNB",
    chainId: 204,
    rpc: "https://opbnb-rpc.publicnode.com",
    coingeckoPlatform: "opbnb",
    nativeCoingeckoId: "binancecoin",
    nativeSymbol: "BNB",
  },
];

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

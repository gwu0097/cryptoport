// No "server-only" guard here (unlike the other adapters) — this file is
// also imported by ChainModeAddressFields.tsx (a client component) so the "is
// this a valid EVM chain label" check can recognize every configured
// chain, not just a hand-copied subset. Nothing in here is sensitive (RPC
// URLs and CoinGecko platform ids are all public), so shipping it to the
// client bundle is fine.

/**
 * EVM chains this app can read on-chain balances for, via Multicall3 on a
 * free, keyless public RPC — no API key, no per-wallet vendor rate limit
 * (unlike the Rabby indexer). Every `rpc` URL below was hand-verified
 * (matching `eth_chainId` against the real chain ID) before being added.
 *
 * 32 chains as of this writing — every EVM chain PublicNode serves
 * keylessly that responded correctly to a real eth_chainId check (a
 * handful of others, e.g. Fantom/Moonbeam/Flare, aren't on PublicNode's
 * keyless tier and were left out rather than guessed at). Ronin is the one
 * exception — PublicNode doesn't serve it, so it uses the official Ronin
 * RPC instead, verified the same way (eth_chainId, and a live eth_getCode
 * check confirming Multicall3 is actually deployed there).
 * Still not literally everything Ankr's paid tier offers (~75), but this
 * covers every chain that showed up when reconciling a real multi-chain
 * wallet against DeBank. Adding another chain is a one-line addition here
 * (id, name, chainId, a verified public RPC URL, CoinGecko platform id) —
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
  /** Tried in order when `rpc` errors or times out (viem's fallback
   * transport, set up in multicallEvm.ts — not here, this file ships to the
   * client). Only for chains where the primary has actually failed. */
  fallbackRpcs?: string[];
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
    rpc: "https://eth.rpc.blxrbdn.com",
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
    // Arbitrum's own public RPC: a 2,995-token balance scan took 1.5s there
    // vs 10.8s on publicnode (0 failures each), and publicnode failed
    // 584-2,070 checks per wallet under Sync all load (2026-09-25).
    rpc: "https://arb1.arbitrum.io/rpc",
    fallbackRpcs: ["https://arbitrum.drpc.org", "https://arbitrum-one-rpc.publicnode.com"],
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
  {
    id: "zksync",
    name: "zkSync Era",
    chainId: 324,
    rpc: "https://mainnet.era.zksync.io",
    coingeckoPlatform: "zksync",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "manta",
    name: "Manta Pacific",
    chainId: 169,
    // Caldera (Manta Pacific's own rollup provider): 0 of 26 token checks
    // failed in 0.25s; drpc's free plan failed all 26 even for one wallet
    // and timed out getBalance under load (2026-09-25). Manta's own
    // pacific-rpc.manta.network didn't respond at all.
    rpc: "https://manta-pacific-gascap.calderachain.xyz/http",
    fallbackRpcs: ["https://manta-pacific-aperture.calderachain.xyz/http"],
    coingeckoPlatform: "manta-pacific",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "mode",
    name: "Mode",
    chainId: 34443,
    rpc: "https://mainnet.mode.network",
    coingeckoPlatform: "mode",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "merlin",
    name: "Merlin Chain",
    chainId: 4200,
    rpc: "https://rpc.merlinchain.io",
    coingeckoPlatform: "merlin-chain",
    nativeCoingeckoId: "wrapped-bitcoin",
    nativeSymbol: "WBTC",
  },
  {
    id: "zetachain",
    name: "ZetaChain",
    chainId: 7000,
    rpc: "https://zetachain-evm.blockpi.network/v1/rpc/public",
    coingeckoPlatform: "zetachain",
    nativeCoingeckoId: "zetachain",
    nativeSymbol: "ZETA",
  },
  {
    id: "metis",
    name: "Metis Andromeda",
    chainId: 1088,
    rpc: "https://metis-rpc.publicnode.com",
    coingeckoPlatform: "metis-andromeda",
    nativeCoingeckoId: "metis-token",
    nativeSymbol: "METIS",
  },
  {
    id: "pulsechain",
    name: "PulseChain",
    chainId: 369,
    rpc: "https://pulsechain-rpc.publicnode.com",
    coingeckoPlatform: "pulsechain",
    nativeCoingeckoId: "pulsechain",
    nativeSymbol: "PLS",
  },
  {
    id: "fraxtal",
    name: "Fraxtal",
    chainId: 252,
    rpc: "https://fraxtal-rpc.publicnode.com",
    coingeckoPlatform: "fraxtal",
    nativeCoingeckoId: "frax-share",
    nativeSymbol: "FRAX",
  },
  {
    id: "unichain",
    name: "Unichain",
    chainId: 130,
    rpc: "https://unichain-rpc.publicnode.com",
    coingeckoPlatform: "unichain",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "berachain",
    name: "Berachain",
    chainId: 80094,
    rpc: "https://berachain-rpc.publicnode.com",
    coingeckoPlatform: "berachain",
    nativeCoingeckoId: "berachain-bera",
    nativeSymbol: "BERA",
  },
  {
    id: "cronos",
    name: "Cronos",
    chainId: 25,
    rpc: "https://cronos-evm-rpc.publicnode.com",
    coingeckoPlatform: "cronos",
    nativeCoingeckoId: "crypto-com-chain",
    nativeSymbol: "CRO",
  },
  {
    id: "kava",
    name: "Kava",
    chainId: 2222,
    rpc: "https://kava-evm-rpc.publicnode.com",
    coingeckoPlatform: "kava",
    nativeCoingeckoId: "kava",
    nativeSymbol: "KAVA",
  },
  {
    id: "sei",
    name: "Sei",
    chainId: 1329,
    rpc: "https://sei-evm-rpc.publicnode.com",
    coingeckoPlatform: "sei-v2",
    // The EVM side's gas coin IS SEI (same asset as the Cosmos side, see
    // cosmos.ts) — was "wrapped-sei"/"WSEI", which labeled a plain SEI
    // balance as the wrapped token and split it from staked SEI on the
    // Assets page (reported 2026-09-24).
    nativeCoingeckoId: "sei-network",
    nativeSymbol: "SEI",
  },
  {
    id: "chiliz",
    name: "Chiliz",
    chainId: 88888,
    rpc: "https://chiliz-rpc.publicnode.com",
    coingeckoPlatform: "chiliz",
    nativeCoingeckoId: "chiliz",
    nativeSymbol: "CHZ",
  },
  {
    id: "soneium",
    name: "Soneium",
    chainId: 1868,
    rpc: "https://soneium-rpc.publicnode.com",
    coingeckoPlatform: "soneium",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "ron",
    name: "Ronin",
    chainId: 2020,
    rpc: "https://api.roninchain.com/rpc",
    coingeckoPlatform: "ronin",
    nativeCoingeckoId: "ronin",
    nativeSymbol: "RON",
  },
  {
    id: "rbh",
    name: "Robinhood Chain",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    coingeckoPlatform: "robinhood",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  // Added 2026-09-25 after a DeBank/Zerion comparison found real balances on
  // them. RPCs, chain ids and Multicall3 checked live; CoinGecko platform ids
  // from GeckoTerminal's network list (coingecko_asset_platform_id).
  {
    id: "pze",
    name: "Polygon zkEVM",
    chainId: 1101,
    rpc: "https://zkevm-rpc.com",
    fallbackRpcs: ["https://polygon-zkevm.drpc.org"],
    coingeckoPlatform: "polygon-zkevm",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "zora",
    name: "Zora",
    chainId: 7777777,
    rpc: "https://rpc.zora.energy",
    fallbackRpcs: ["https://zora.drpc.org"],
    coingeckoPlatform: "zora-network",
    nativeCoingeckoId: "ethereum",
    nativeSymbol: "ETH",
  },
  {
    id: "ftm",
    name: "Fantom",
    chainId: 250,
    rpc: "https://rpcapi.fantom.network",
    fallbackRpcs: ["https://fantom.drpc.org"],
    coingeckoPlatform: "fantom",
    nativeCoingeckoId: "fantom",
    nativeSymbol: "FTM",
  },
];

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const EVM_CHAIN_IDS_UPPER = new Set(EVM_CHAINS.map((c) => c.id.toUpperCase()));

/** Whether `chain` (a wallet's own `chain` field, e.g. "ETH", "RON",
 * "SEI") names one of the EVM chains above — every one of them is reached
 * by scanning the SAME EVM address across every chain above (see evm.ts), so a
 * wallet's `chain` value here is purely a display label ("this address is
 * primarily a Ronin wallet"), not a restriction on which chains actually
 * get scanned. */
export function isEvmChainId(chain: string): boolean {
  return EVM_CHAIN_IDS_UPPER.has(chain.toUpperCase());
}

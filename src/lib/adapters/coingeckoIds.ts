// Plain data, no "server-only" guard — same reasoning as nonEvmChains.ts:
// pure lookup tables get to be imported from both server-only code
// (coingecko.ts's fetches) and pure logic (priceKey.ts's resolver), which
// a server-only guard on this file would block for no benefit (nothing
// here is sensitive; every id is public CoinGecko vocabulary).

// Chain ids this app has that aren't in EVM_CHAINS (so have no
// `coingeckoPlatform` of their own to look up by) but still correspond to a
// real CoinGecko asset_platforms entry, keyed by that platform's own id.
export const NON_EVM_PLATFORM_IDS: Record<string, string> = {
  solana: "solana",
  hyperliquid: "hyperliquid",
  cardano: "cardano",
};

// Non-EVM chains with no CoinGecko asset_platforms entry at all — see the
// native-icon fallback in coingecko.ts's refreshTokenRegistry.
export const NATIVE_ICON_CHAINS: Record<string, string> = {
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

/** CoinGecko coin id for a chain's native token, for chains not covered by
 * EVM_CHAINS' own `nativeCoingeckoId` — the union of the two maps above.
 * Used by priceKey.ts to resolve a non-EVM native holding (BTC, SOL, ADA,
 * ...) to a coin id for historical-price lookups; NON_EVM_PLATFORM_IDS'
 * values (CoinGecko platform ids, e.g. "solana") happen to equal the coin
 * id for every chain currently in it, which is why it's safe to fold both
 * maps into one id lookup here. */
export const NATIVE_COINGECKO_IDS: Record<string, string> = {
  ...NON_EVM_PLATFORM_IDS,
  ...NATIVE_ICON_CHAINS,
};

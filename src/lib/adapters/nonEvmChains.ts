// Plain config data, deliberately NOT server-only — mirrors evmChains.ts's
// own reasoning (see that file's header): no secrets, no I/O, safe for a
// client component (ChainModeFields.tsx) to import directly. This is the
// single source of truth for "which non-EVM chains does this app have an
// adapter for, and what's each one's display name / grouping slug" —
// replacing what used to be the same ~15-chain list hand-copied across
// chainNames.ts's CHAIN_NAMES, chainNames.ts's defaultChainId,
// wallets/actions.ts's AUTO_CAPABLE_CHAINS, and ChainModeFields.tsx's
// NON_EVM_AUTO_CAPABLE_CHAINS. That duplication had already silently
// drifted once: defaultChainId had no explicit case for NEO or TON and
// only worked by coincidence (their uppercase ticker happens to lowercase
// into their real chain id, unlike XRP, which needed an explicit case
// because "XRP".toLowerCase() !== "xrpl"). One list now, so that class of
// gap can't reappear.
//
// The actual fetch/detect logic (which needs the real adapters, all
// server-only) lives separately in nonEvmDispatch.ts — this file only ever
// holds strings.
export interface NonEvmChain {
  /** The value stored in wallets.chain / returned by lookup.ts's
   * detectChain — always uppercase. */
  id: string;
  /** Adapter-native grouping slug — see chainNames.ts's defaultChainId doc
   * comment for why this has to differ from `id` for grouping manual
   * holdings correctly alongside auto-synced ones. */
  slug: string;
  displayName: string;
}

// BTC and ADA are included here (for their name/slug) even though they're
// deliberately excluded from nonEvmDispatch.ts's generic fetch table —
// both need extra cached state (script type, stake address) threaded
// through that doesn't fit a plain "address in, holdings out" shape, so
// they stay as bespoke calls at each call site, same as before this
// change. They still belong in this list: every other piece of code that
// asks "is this chain one we have an adapter for" (naming, auto-capable
// checks) needs to see them too.
export const NON_EVM_CHAINS: NonEvmChain[] = [
  { id: "BTC", slug: "bitcoin", displayName: "Bitcoin" },
  { id: "SOL", slug: "solana", displayName: "Solana" },
  { id: "ADA", slug: "cardano", displayName: "Cardano" },
  { id: "ATOM", slug: "cosmoshub", displayName: "Cosmos Hub" },
  { id: "INJ", slug: "injective", displayName: "Injective" },
  { id: "SUI", slug: "sui", displayName: "Sui" },
  { id: "FIL", slug: "filecoin", displayName: "Filecoin" },
  { id: "BCH", slug: "bitcoincash", displayName: "Bitcoin Cash" },
  { id: "NEAR", slug: "near", displayName: "NEAR" },
  { id: "DOT", slug: "polkadot", displayName: "Polkadot" },
  { id: "TAO", slug: "bittensor", displayName: "Bittensor" },
  { id: "NEO", slug: "neo", displayName: "NEO" },
  { id: "XRP", slug: "xrpl", displayName: "XRP Ledger" },
  { id: "TON", slug: "ton", displayName: "TON" },
  { id: "APT", slug: "aptos", displayName: "Aptos" },
  { id: "ICP", slug: "internet-computer", displayName: "Internet Computer" },
];

export function findNonEvmChain(id: string): NonEvmChain | undefined {
  return NON_EVM_CHAINS.find((c) => c.id === id);
}

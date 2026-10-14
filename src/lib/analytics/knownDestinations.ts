// Addresses whose owner is known and the same for every user: a send there
// is labelled with where it went (docs/analytics/WHERE_IT_WENT.md). Pure.
//
// Only shared contracts belong here — an exchange's deposit addresses are
// per user and can't be listed. Matched by address on any chain (these are
// contracts on one chain; another chain's same address would be a
// different, deliberately deployed contract of the same project).
//
// Hyperliquid (owner 2026-10-14: "if it went to hyperliquid account, just
// say that"): its Arbitrum bridge and the CCTP deposit contract. The
// owner's five USDC deposits of 2026-10-07/09/14 went to these and reached
// the Hyperliquid account within a minute. Its ledger isn't read.

const KNOWN: Record<string, string> = {
  "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7": "Hyperliquid", // Arbitrum: Bridge2
  "0xa95d9c1f655341597c94393fddc30cf3c08e4fce": "Hyperliquid", // Arbitrum: CctpExtension
};

/** The known owner of an address, or null. Case-insensitive. */
export function knownDestination(address: string | null | undefined): string | null {
  if (!address) return null;
  return KNOWN[address.toLowerCase()] ?? null;
}

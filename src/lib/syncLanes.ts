// "Sync all" runs wallets in lanes: wallets whose syncs hit the same
// rate-limited APIs share a lane and go one at a time; different lanes run
// at the same time. Pure (no DB, no network).
//
// All 12 EVM wallets syncing at once sent ~60 simultaneous requests to
// Arbitrum's free RPC (800–2,000 balance checks per wallet failed), and nine
// Solana wallets tripped Jupiter's 10-requests-per-10s limit (2026-09-25).
// An EVM address is the same on every EVM chain, so an ETH-, RON- or 0x
// SEI-labeled wallet runs the identical 32-chain scan: one lane.

export function syncLane(
  w: { chain: string; provider: string | null; address: string | null },
  isEvmChain: (chain: string) => boolean,
): string {
  if (w.provider) return `exchange:${w.provider}`;
  const chain = w.chain.toUpperCase();
  if (chain === "SEI") return w.address?.startsWith("sei1") ? "cosmos" : "evm";
  if (isEvmChain(chain)) return "evm";
  // The Cosmos multi-chain scan (ATOM) reads ~160 chains' public endpoints,
  // Sei's included; a sei1 wallet reads Sei's.
  if (chain === "ATOM") return "cosmos";
  if (chain === "SOL") return "solana"; // Jupiter
  return chain; // its own API: BTC, ADA, SUI, NEAR, ICP, XRP, TAO, ...
}

/** Wallets grouped into lanes, keeping their given order within a lane. */
export function groupByLane<T>(items: T[], laneOf: (item: T) => string): T[][] {
  const lanes = new Map<string, T[]>();
  for (const item of items) {
    const lane = laneOf(item);
    lanes.set(lane, [...(lanes.get(lane) ?? []), item]);
  }
  return [...lanes.values()];
}

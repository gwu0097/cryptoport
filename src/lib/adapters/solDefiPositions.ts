import "server-only";
import type { AdapterHolding } from "./types";
import { fetchJupiterPositions } from "./jupiterPositions";
import { fetchKaminoPositions } from "./kaminoPositions";
import { fetchWormholeStaking } from "./wormholeStaking";
import { fetchMeteoraPositions } from "./meteoraPositions";
import { fetchParclPositions } from "./parclPositions";

export interface SolPositionsResult {
  holdings: AdapterHolding[];
  warnings: string[];
}

// Every SOL DeFi position source beyond plain token balances — shared by
// both a saved wallet's real sync (wallets/actions.ts) and the ad-hoc
// address lookup (lib/lookup.ts) so the two don't drift. Each source is
// independent: one throwing becomes a warning, never discards another
// source's correctly-fetched data (same rule as evm.ts's chains+
// Hyperliquid split). Add a new protocol here as its own entry once it
// has a verified adapter — this is the only place a new SOL DeFi source
// needs wiring in.
const SOURCES: { name: string; fetch: (address: string) => Promise<SolPositionsResult> }[] = [
  { name: "jupiter positions", fetch: fetchJupiterPositions },
  { name: "kamino", fetch: fetchKaminoPositions },
  {
    name: "wormhole",
    fetch: (address) => fetchWormholeStaking(address).then((holdings) => ({ holdings, warnings: [] })),
  },
  { name: "meteora", fetch: fetchMeteoraPositions },
  { name: "parcl", fetch: fetchParclPositions },
];

export async function fetchSolDefiPositions(address: string): Promise<SolPositionsResult> {
  const results = await Promise.all(
    SOURCES.map(({ name, fetch }) =>
      fetch(address).catch((e: Error) => ({
        holdings: [] as AdapterHolding[],
        warnings: [`${name}: ${e.message}`],
      })),
    ),
  );
  return {
    holdings: results.flatMap((r) => r.holdings),
    warnings: results.flatMap((r) => r.warnings),
  };
}

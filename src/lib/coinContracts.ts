// Which token address a coin row copies when the row is a coin, not a
// holding (the Watchlist, the Encyclopedia) — owner 2026-10-06: "I keep
// finding tokens with no copy contract". Pure: the addresses that can be
// copied as they are, and which one a single button copies.
//
// Only addresses whose letter case doesn't matter or is known: EVM
// contracts from token_registry (stored lowercase, which an EVM address
// accepts), and a `jup:<mint>` coin's own mint. token_registry's Solana and
// Sui rows are lowercased too, and a lowercased mint or coin type is a
// different (wrong) address — never offered.

import { EVM_CHAINS } from "./adapters/evmChains.ts";

export interface CoinContract {
  chainId: string;
  chainName: string;
  contract: string;
}

const EVM_ORDER = new Map(EVM_CHAINS.map((c, i) => [c.id, i]));
const EVM_NAME = new Map(EVM_CHAINS.map((c) => [c.id, c.name]));

/** A coin key's own address: a `jup:<mint>` key is the mint itself. */
export function ownContract(coinKey: string): CoinContract | null {
  const mint = coinKey.startsWith("jup:") ? coinKey.slice(4) : null;
  return mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? { chainId: "solana", chainName: "Solana", contract: mint } : null;
}

/** token_registry rows (chain_id, contract) to the ones safe to copy, in
 * evmChains.ts's order (Ethereum first), each address once. */
export function copyableContracts(rows: readonly { chain_id: string; contract: string }[]): CoinContract[] {
  const seen = new Set<string>();
  return rows
    .filter((r) => EVM_ORDER.has(r.chain_id) && /^0x[0-9a-f]{40}$/i.test(r.contract))
    .sort((a, b) => (EVM_ORDER.get(a.chain_id) ?? 0) - (EVM_ORDER.get(b.chain_id) ?? 0))
    .filter((r) => !seen.has(`${r.chain_id}:${r.contract}`) && seen.add(`${r.chain_id}:${r.contract}`))
    .map((r) => ({ chainId: r.chain_id, chainName: EVM_NAME.get(r.chain_id) ?? r.chain_id, contract: r.contract.toLowerCase() }));
}

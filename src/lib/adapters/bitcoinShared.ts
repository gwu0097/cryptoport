import "server-only";
import { fetchWithRetry } from "./http";

// mempool.space's Esplora-derived REST API — free, keyless, no per-IP rate
// limit tighter than a normal wallet app would hit (a single address
// lookup per sync, nothing like the EVM adapter's thousands-of-tokens
// scan). Bitcoin has no account-balance RPC without running your own
// address-indexed node, so — same reasoning as Jupiter for Solana — this
// is a trusted third-party API rather than a direct chain read. Shared by
// bitcoin.ts's single-address path and bitcoinXpub.ts's per-derived-
// address scanning (a separate module so the two don't import each other).
const API_BASE = "https://mempool.space/api";

export interface AddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
}

export const SATS_PER_BTC = 100_000_000;

export async function fetchAddressStats(address: string): Promise<AddressStats> {
  const res = await fetchWithRetry(`${API_BASE}/address/${address}`);
  if (!res.ok) throw new Error(`mempool.space address lookup failed: HTTP ${res.status}`);
  return res.json();
}

export function satsFromStats(stats: AddressStats): number {
  const confirmed = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
  const mempool = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum;
  return confirmed + mempool;
}

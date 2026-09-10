import "server-only";
import { fetchWithRetry } from "./http";

// Esplora-family REST API — free, keyless, no per-IP rate limit tighter
// than a normal wallet app would hit (a single address lookup per sync,
// nothing like the EVM adapter's thousands-of-tokens scan). Bitcoin has no
// account-balance RPC without running your own address-indexed node, so —
// same reasoning as Jupiter for Solana — this is a trusted third-party API
// rather than a direct chain read. Shared by bitcoin.ts's single-address
// path and bitcoinXpub.ts's per-derived-address scanning (a separate
// module so the two don't import each other).
//
// blockstream.info is primary now, not mempool.space — flipped after
// timing a real xpub scan against both: mempool.space was hard rate-
// limiting almost every request (repeated 429s, one call that hung for
// 38s), the exact same scan against blockstream.info alone completed in
// under 3 seconds total. Same response schema either way (blockstream.info
// is the esplora fork mempool.space itself descends from), so this is a
// pure swap — mempool.space kept as the fallback for whenever the
// situation reverses.
const PRIMARY_BASE = "https://blockstream.info/api";
const FALLBACK_BASE = "https://mempool.space/api";

export interface AddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
}

export const SATS_PER_BTC = 100_000_000;

export async function fetchAddressStats(address: string): Promise<AddressStats> {
  try {
    const res = await fetchWithRetry(`${PRIMARY_BASE}/address/${address}`, {}, { attempts: 2 });
    if (res.ok) return res.json();
  } catch {
    // fall through to blockstream.info below
  }

  const res = await fetchWithRetry(`${FALLBACK_BASE}/address/${address}`);
  if (!res.ok) throw new Error(`Bitcoin address lookup failed: HTTP ${res.status}`);
  return res.json();
}

export function satsFromStats(stats: AddressStats): number {
  const confirmed = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
  const mempool = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum;
  return confirmed + mempool;
}

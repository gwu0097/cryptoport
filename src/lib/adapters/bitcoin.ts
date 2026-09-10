import "server-only";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// mempool.space's Esplora-derived REST API — free, keyless, no per-IP rate
// limit tighter than a normal wallet app would hit (a single address
// lookup per sync, nothing like the EVM adapter's thousands-of-tokens
// scan). Bitcoin has no account-balance RPC without running your own
// address-indexed node, so — same reasoning as Jupiter for Solana — this
// is a trusted third-party API rather than a direct chain read.
const API_BASE = "https://mempool.space/api";

interface AddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
}

const SATS_PER_BTC = 100_000_000;

/**
 * A BTC wallet only ever has one holding (native BTC — no tokens, no
 * contracts). Balance = confirmed UTXOs + unconfirmed mempool UTXOs, same
 * "funded minus spent" arithmetic Esplora-family explorers all use.
 * Includes unconfirmed activity rather than only confirmed, matching how
 * Rabby/DeBank show a wallet's balance as soon as a transaction is seen,
 * not after the next block.
 *
 * Priced via the shared ticker-keyed `prices` table (usd_override: null,
 * not fetched here) — BTC is already priced there today for manual
 * holdings, same as every other ticker (see prices.ts).
 */
export async function fetchBitcoinHoldings(address: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(`${API_BASE}/address/${address}`);
  if (!res.ok) throw new Error(`mempool.space address lookup failed: HTTP ${res.status}`);
  const stats: AddressStats = await res.json();

  const confirmedSats = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
  const mempoolSats = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum;
  const sats = confirmedSats + mempoolSats;
  if (sats <= 0) return [];

  const images = await fetchTokenImages(["bitcoin"]).catch(() => new Map<string, string>());

  return [
    {
      ticker: "BTC",
      qty: sats / SATS_PER_BTC,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "bitcoin",
      icon_url: images.get("bitcoin") ?? null,
    },
  ];
}

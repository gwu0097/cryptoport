import "server-only";
import { fetchTokenImages } from "./coingecko";
import { scanExtendedKey, isExtendedPublicKey } from "./bitcoinXpub";
import { fetchAddressStats, satsFromStats, SATS_PER_BTC } from "./bitcoinShared";
import type { AdapterHolding } from "./types";

async function buildBtcHolding(sats: number): Promise<AdapterHolding[]> {
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

/**
 * A BTC wallet only ever has one holding (native BTC — no tokens, no
 * contracts). Two input shapes:
 *
 * - A single address: balance = confirmed UTXOs + unconfirmed mempool
 *   UTXOs, same "funded minus spent" arithmetic Esplora-family explorers
 *   all use. Includes unconfirmed activity, matching how Rabby/DeBank show
 *   a wallet's balance as soon as a transaction is seen, not after the
 *   next block. Correct only if this literally is the address holding the
 *   funds — most HD wallets (Ledger included) rotate to a new receive
 *   address per deposit, so a single address usually undercounts.
 * - An extended public key (xpub/ypub/zpub): the correct way to track an
 *   HD wallet account — derives and scans every address in that account
 *   (see bitcoinXpub.ts) the same way Ledger Live/Electrum do, and sums
 *   whatever has a balance.
 *
 * Priced via the shared ticker-keyed `prices` table (usd_override: null,
 * not fetched here) — BTC is already priced there today for manual
 * holdings, same as every other ticker (see prices.ts).
 */
export async function fetchBitcoinHoldings(addressOrXpub: string): Promise<AdapterHolding[]> {
  if (isExtendedPublicKey(addressOrXpub)) {
    const sats = await scanExtendedKey(addressOrXpub);
    return buildBtcHolding(sats);
  }

  const stats = await fetchAddressStats(addressOrXpub);
  return buildBtcHolding(satsFromStats(stats));
}

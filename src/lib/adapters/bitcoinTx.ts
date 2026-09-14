import "server-only";
import { fetchAddressTxs, type EsploraTx, SATS_PER_BTC } from "./bitcoinShared";
import { mapWithConcurrency } from "./http";
import type { AdapterTransaction } from "./types";

const EXPLORER_BASE = "https://blockstream.info/tx";

/**
 * A Bitcoin transaction's effect on a wallet only makes sense relative to
 * the *whole set* of addresses that wallet owns (one for a plain address
 * wallet, many for an xpub) — classifying input/output-by-input/output
 * against a single address would misread ordinary internal change (a spend
 * that sends leftover sats back to another of the wallet's own derived
 * addresses) as an external transfer. netSats is this wallet's total
 * balance change across every one of its addresses combined; a tx that
 * only moves sats between two of the wallet's own addresses nets to (close
 * to) zero fee-aside and is dropped by the caller rather than shown as a
 * confusing $0 "transaction."
 */
function classify(
  tx: EsploraTx,
  ownAddresses: Set<string>,
): { netSats: number; counterparty: string | null; fee: number | null } {
  let inFromSelf = 0;
  let outToSelf = 0;
  let totalIn = 0;
  let totalOut = 0;
  let firstOtherOut: string | null = null;
  let firstOtherIn: string | null = null;
  let allInputsKnown = true;

  for (const input of tx.vin) {
    const addr = input.prevout?.scriptpubkey_address;
    const value = input.prevout?.value;
    if (value === undefined) allInputsKnown = false;
    else totalIn += value;
    if (addr && ownAddresses.has(addr)) inFromSelf += value ?? 0;
    else if (!firstOtherIn && addr) firstOtherIn = addr;
  }
  for (const output of tx.vout) {
    totalOut += output.value;
    const addr = output.scriptpubkey_address;
    if (addr && ownAddresses.has(addr)) outToSelf += output.value;
    else if (!firstOtherOut && addr) firstOtherOut = addr;
  }

  const netSats = outToSelf - inFromSelf;
  const counterparty = netSats >= 0 ? firstOtherIn : firstOtherOut;
  // Only meaningful as "the fee this wallet paid" when this wallet is the
  // one that initiated the send (it supplied at least one input) — for a
  // purely-incoming transfer, whoever sent it paid the fee, not this
  // wallet, so fee stays null there rather than showing someone else's fee
  // as if it were this wallet's own.
  const fee = allInputsKnown && inFromSelf > 0 ? totalIn - totalOut : null;

  return { netSats, counterparty, fee };
}

/**
 * Fetches and merges each of a Bitcoin wallet's own addresses' recent
 * transactions (a plain wallet has one address; an xpub wallet has however
 * many bitcoinXpub.ts's scan found active — see its ScanResult.addresses)
 * into one wallet-level list, deduped by txid (one tx often appears under
 * more than one of the wallet's own addresses — an input from one,
 * change back to another). Each Esplora call is capped at its own 25 most
 * recent (see fetchAddressTxs) — not paginated further, matching
 * transactionSync.ts's overall per-wallet cap.
 */
export async function fetchBitcoinTransactions(addresses: string[]): Promise<AdapterTransaction[]> {
  const ownSet = new Set(addresses);
  const perAddress = await mapWithConcurrency(addresses, 3, (addr) => fetchAddressTxs(addr));

  const byTxid = new Map<string, EsploraTx>();
  for (const list of perAddress) for (const tx of list) byTxid.set(tx.txid, tx);

  const results: AdapterTransaction[] = [];
  for (const tx of byTxid.values()) {
    const { netSats, counterparty, fee } = classify(tx, ownSet);
    if (netSats === 0) continue; // no net effect on this wallet as a whole — an internal shuffle between its own addresses
    results.push({
      txHash: tx.txid,
      chain: "bitcoin",
      // Unconfirmed (mempool) txs have no block_time yet — "now" is a
      // reasonable stand-in since a pending tx belongs at the top of a
      // newest-first list regardless, not an attempt at its real time.
      occurredAt: tx.status.block_time
        ? new Date(tx.status.block_time * 1000).toISOString()
        : new Date().toISOString(),
      direction: netSats > 0 ? "in" : "out",
      ticker: "BTC",
      amount: Math.abs(netSats) / SATS_PER_BTC,
      counterparty,
      explorerUrl: `${EXPLORER_BASE}/${tx.txid}`,
      fee: fee !== null ? fee / SATS_PER_BTC : null,
    });
  }

  return results.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

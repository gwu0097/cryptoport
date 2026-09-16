import "server-only";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import type { AdapterTransaction } from "./types";

// Same Koios host as cardano.ts's own balance lookups. Live-verified
// (2026-09) against 3 real wallets in this app: /address_txs, /tx_info,
// and /tx_utxos are all keyless, no rate-limit headers observed under a
// short burst, and /tx_utxos carries stake_addr directly on every
// input/output — which is what makes classifying a UTXO as "this
// wallet's" a plain equality check against the wallet's own cached stake
// address, no address-set membership test needed the way bitcoinTx.ts's
// xpub handling requires.
const API_BASE = "https://api.koios.rest/api/v1";
const LOVELACE_PER_ADA = 1_000_000;
const EXPLORER_BASE = "https://cardanoscan.io/transaction";
const CONCURRENCY = 3;
const BATCH_SIZE = 50;

interface AddressTxRow {
  tx_hash: string;
}

interface TxInfoRow {
  tx_hash: string;
  tx_timestamp: number;
  fee: string;
}

interface Utxo {
  value: string;
  stake_addr: string | null;
  payment_addr: { bech32: string };
}

interface TxUtxosRow {
  tx_hash: string;
  inputs: Utxo[];
  outputs: Utxo[];
}

async function koios<T>(path: string, body: Record<string, unknown>, context: string): Promise<T> {
  const res = await fetchWithRetry(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Koios ${context} failed: HTTP ${res.status}`);
  return res.json();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Every payment address ever associated with a stake key — a Cardano
 * wallet's real transaction history lives across all of them, not just
 * whichever one happens to be the wallet's "current" receive address
 * (same reasoning cardano.ts's own doc comment gives for balances: address
 * rotation means a single address's own history is routinely incomplete). */
async function fetchAccountAddresses(stakeAddress: string): Promise<string[]> {
  const rows = await koios<{ addresses: string[] }[]>(
    "/account_addresses",
    { _stake_addresses: [stakeAddress] },
    "account_addresses",
  );
  return rows[0]?.addresses ?? [];
}

/** Shared core: given the set of addresses to pull history for and a way
 * to tell whether one UTXO belongs to this wallet, fetches and classifies
 * every transaction those addresses appear in. Direction/amount/
 * counterparty come from tx_utxos, not tx_info — live-verified that
 * tx_info's own `inputs` array is always empty, a real gap in that
 * endpoint. Native ADA only, same scope as cardano.ts's own balance
 * tracking (Cardano native tokens/CNTs are a separate backlog item — a tx
 * moving one is still picked up here but its non-ADA legs are silently
 * dropped rather than shown as a wrong ticker). */
async function fetchAndClassify(addresses: string[], isOwn: (u: Utxo) => boolean): Promise<AdapterTransaction[]> {
  if (addresses.length === 0) return [];

  const txRows = await koios<AddressTxRow[]>("/address_txs", { _addresses: addresses }, "address_txs");
  const hashes = [...new Set(txRows.map((r) => r.tx_hash))];
  if (hashes.length === 0) return [];

  const [infoRows, utxoRows] = await Promise.all([
    mapWithConcurrency(chunk(hashes, BATCH_SIZE), CONCURRENCY, (batch) =>
      koios<TxInfoRow[]>("/tx_info", { _tx_hashes: batch }, "tx_info"),
    ).then((r) => r.flat()),
    mapWithConcurrency(chunk(hashes, BATCH_SIZE), CONCURRENCY, (batch) =>
      koios<TxUtxosRow[]>("/tx_utxos", { _tx_hashes: batch }, "tx_utxos"),
    ).then((r) => r.flat()),
  ]);

  const infoByHash = new Map(infoRows.map((r) => [r.tx_hash, r]));

  const results: AdapterTransaction[] = [];
  for (const row of utxoRows) {
    const info = infoByHash.get(row.tx_hash);
    let ownIn = 0;
    let ownOut = 0;
    let otherIn: string | null = null;
    let otherOut: string | null = null;

    for (const input of row.inputs) {
      if (isOwn(input)) ownIn += Number(input.value);
      else if (!otherIn) otherIn = input.payment_addr.bech32;
    }
    for (const output of row.outputs) {
      if (isOwn(output)) ownOut += Number(output.value);
      else if (!otherOut) otherOut = output.payment_addr.bech32;
    }

    const netLovelace = ownOut - ownIn;
    if (netLovelace === 0) continue; // no net ADA effect on this wallet (e.g. an internal shuffle between its own addresses)
    // Only meaningful as "the fee this wallet paid" when it supplied at
    // least one input — same reasoning as bitcoinTx.ts's classify().
    const fee = info && ownIn > 0 ? Number(info.fee) / LOVELACE_PER_ADA : null;

    results.push({
      txHash: row.tx_hash,
      chain: "cardano",
      occurredAt: new Date((info?.tx_timestamp ?? 0) * 1000).toISOString(),
      direction: netLovelace > 0 ? "in" : "out",
      ticker: "ADA",
      amount: Math.abs(netLovelace) / LOVELACE_PER_ADA,
      counterparty: netLovelace >= 0 ? otherIn : otherOut,
      explorerUrl: `${EXPLORER_BASE}/${row.tx_hash}`,
      fee,
    });
  }

  return results.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** The common case: a wallet with a known stake address — pulls every
 * payment address under that stake key and classifies UTXOs by
 * stake_addr equality, which Koios resolves server-side per UTXO. */
export async function fetchCardanoTransactions(stakeAddress: string): Promise<AdapterTransaction[]> {
  const addresses = await fetchAccountAddresses(stakeAddress);
  return fetchAndClassify(addresses, (u) => u.stake_addr === stakeAddress);
}

/** Fallback for the rare address type with no inline staking credential
 * (pointer/enterprise — see cardano.ts's deriveStakeAddress doc comment)
 * — scoped to this one address only, classified by payment_addr equality
 * instead of a stake key, since there is none to group by. */
export async function fetchCardanoTransactionsByAddress(address: string): Promise<AdapterTransaction[]> {
  return fetchAndClassify([address], (u) => u.payment_addr.bech32 === address);
}

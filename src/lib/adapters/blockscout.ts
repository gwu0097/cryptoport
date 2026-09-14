import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterTransaction } from "./types";

/**
 * Blockscout — a separate, independent, free/keyless explorer many chains
 * run their own hosted instance of. Genuinely separate infrastructure from
 * Etherscan (no shared key, no shared daily quota), which is what makes it
 * worth using in parallel rather than as a mere fallback: live-tested with
 * a real address against every host below and confirmed working. Covers
 * two of etherscan.ts's FREE_TIER_UNSUPPORTED chains (Base, Optimism —
 * Etherscan gates these behind a paid plan, Blockscout doesn't) plus eight
 * chains Etherscan's unified API has no coverage for at all. Response
 * shape is consistent enough across every host tested (a couple, like
 * Merlin/Metis, run an older Blockscout version with extra/renamed fields
 * elsewhere in the payload, but every field this app actually reads —
 * hash, timestamp, from/to, value, status, fee — is identical) that one
 * parser covers all of them; no per-host special-casing needed.
 *
 * Not found with a free source even via Blockscout: Avalanche (its
 * instance is behind bot-protection that blocks a plain server-side
 * fetch), BSC (no Blockscout instance exists), Manta.
 */
export const BLOCKSCOUT_HOSTS: Record<string, string> = {
  base: "base.blockscout.com",
  op: "explorer.optimism.io",
  zksync: "zksync.blockscout.com",
  scrl: "scrollscan.com",
  zetachain: "zetascan.com",
  mode: "explorer.mode.network",
  merlin: "scan.merlinchain.io",
  metis: "andromeda-explorer.metis.io",
  xdai: "gnosisscan.io",
  ron: "explorer.roninchain.com",
};

interface BlockscoutAddressRef {
  hash: string;
}

interface BlockscoutTxItem {
  hash: string;
  timestamp: string;
  status: string; // "ok" | "error"
  value: string; // wei, as a string
  from: BlockscoutAddressRef;
  to: BlockscoutAddressRef | null; // null for a contract-creation tx
  fee: { value: string | null };
}

interface BlockscoutTokenTransferItem {
  transaction_hash: string;
  timestamp: string;
  from: BlockscoutAddressRef;
  to: BlockscoutAddressRef;
  token: { symbol: string | null; decimals: string | null };
  total: { value: string; decimals: string | null } | null; // null for an NFT transfer (no fungible amount)
}

async function fetchPage<T>(host: string, path: string): Promise<T[]> {
  const res = await fetchWithRetry(`https://${host}${path}`);
  if (!res.ok) throw new Error(`Blockscout (${host}) failed: HTTP ${res.status}`);
  const body: { items?: T[] } = await res.json();
  return body.items ?? [];
}

/** Native-token transfers plus ERC-20 transfers, merged — same txlist +
 * tokentx split as etherscan.ts, for the same reason (Blockscout's own
 * /transactions listing doesn't reliably include every token_transfer
 * inline; /token-transfers is the source of truth for those). */
export async function fetchBlockscoutTransactions(
  evmChainId: string,
  address: string,
  nativeSymbol: string,
): Promise<AdapterTransaction[]> {
  const host = BLOCKSCOUT_HOSTS[evmChainId];
  if (!host) return [];
  const lower = address.toLowerCase();
  const explorerBase = `https://${host}`;

  const [native, tokens] = await Promise.all([
    fetchPage<BlockscoutTxItem>(host, `/api/v2/addresses/${address}/transactions`),
    fetchPage<BlockscoutTokenTransferItem>(host, `/api/v2/addresses/${address}/token-transfers`),
  ]);

  const results: AdapterTransaction[] = [];

  for (const tx of native) {
    if (tx.status !== "ok") continue; // reverted — no real transfer happened
    if (tx.value === "0") continue; // a contract-call/token-only tx — its real transfer (if any) is in `tokens` below
    const from = tx.from.hash.toLowerCase();
    const to = tx.to?.hash.toLowerCase();
    const direction = to === lower && from === lower ? "self" : to === lower ? "in" : from === lower ? "out" : "unknown";
    results.push({
      txHash: tx.hash,
      chain: evmChainId,
      occurredAt: tx.timestamp,
      direction,
      ticker: nativeSymbol,
      amount: Number(tx.value) / 1e18,
      counterparty: direction === "out" ? (tx.to?.hash ?? null) : tx.from.hash,
      explorerUrl: `${explorerBase}/tx/${tx.hash}`,
      fee: from === lower && tx.fee.value ? Number(tx.fee.value) / 1e18 : null,
    });
  }

  for (const row of tokens) {
    if (!row.total) continue; // an NFT transfer, not a fungible amount — no honest single "amount" to show
    const from = row.from.hash.toLowerCase();
    const to = row.to.hash.toLowerCase();
    const direction = to === lower && from === lower ? "self" : to === lower ? "in" : from === lower ? "out" : "unknown";
    const decimals = Number(row.total.decimals ?? row.token.decimals ?? 18) || 18;
    results.push({
      txHash: row.transaction_hash,
      chain: evmChainId,
      occurredAt: row.timestamp,
      direction,
      ticker: row.token.symbol,
      amount: Number(row.total.value) / 10 ** decimals,
      counterparty: direction === "out" ? row.to.hash : row.from.hash,
      explorerUrl: `${explorerBase}/tx/${row.transaction_hash}`,
      fee: null, // gas is paid in the native token — the matching native-tx row (same hash) already carries it
    });
  }

  return results;
}

import "server-only";
import { fetchWithRetry } from "./http";
import { listedContracts } from "./tokenListing";
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
  aurora: "explorer.mainnet.aurora.dev", // checked 2026-09-25 (token discovery)
};

interface BlockscoutAddressRef {
  hash: string;
}

interface BlockscoutTxItem {
  hash: string;
  timestamp: string;
  status: string; // "ok" | "error"
  value: string; // wei, as a string
  // Real bug, caught live: `from` is null too on at least some L2 chains'
  // synthetic/system transactions (e.g. an L1-attributes or deposit-style
  // entry an Optimism-family chain injects) — a plain `tx.from.hash`
  // crashed a real sync ("Cannot read properties of undefined"). Typed as
  // nullable like `to` already was, and every access site below is guarded
  // the same way.
  from: BlockscoutAddressRef | null;
  to: BlockscoutAddressRef | null; // null for a contract-creation tx
  fee: { value: string | null };
}

interface BlockscoutTokenTransferItem {
  transaction_hash: string;
  timestamp: string;
  from: BlockscoutAddressRef;
  to: BlockscoutAddressRef;
  token: { symbol: string | null; decimals: string | null; address_hash: string };
  total: { value: string; decimals: string | null } | null; // null for an NFT transfer (no fungible amount)
}

async function fetchPage<T>(host: string, path: string): Promise<T[]> {
  const res = await fetchWithRetry(`https://${host}${path}`);
  // An address this explorer has never seen: 404 {"message":"Not found"} —
  // no history, not a failure.
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    if (body?.message === "Not found") return [];
  }
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
    const from = tx.from?.hash.toLowerCase();
    const to = tx.to?.hash.toLowerCase();
    const direction = to === lower && from === lower ? "self" : to === lower ? "in" : from === lower ? "out" : "unknown";
    results.push({
      txHash: tx.hash,
      chain: evmChainId,
      occurredAt: tx.timestamp,
      direction,
      ticker: nativeSymbol,
      amount: Number(tx.value) / 1e18,
      counterparty: direction === "out" ? (tx.to?.hash ?? null) : (tx.from?.hash ?? null),
      explorerUrl: `${explorerBase}/tx/${tx.hash}`,
      fee: from === lower && tx.fee.value ? Number(tx.fee.value) / 1e18 : null,
    });
  }

  // Same CoinGecko-listing spam filter as etherscan.ts, same reasoning —
  // Blockscout's own `reputation`/`exchange_rate` fields turned out
  // unreliable for this (a real, 189,000-holder USDT transfer on Scroll
  // still showed exchange_rate: null, right alongside actual airdrop-spam
  // tokens on Base), so CoinGecko listing status is the trusted signal
  // instead — this app already prices real assets from it everywhere
  // else, and it never lists unsolicited spam. Display-only curation, not
  // a valuation decision, so the known false-positive risk (a genuinely
  // new, not-yet-listed real token also gets hidden) is acceptable here.
  // Fails open, not closed — same reasoning as etherscan.ts's identical
  // guard: a CoinGecko hiccup here must never take down this chain's real
  // transaction data.
  const contracts = [
    ...new Set(tokens.filter((t) => t.total && t.token.address_hash).map((t) => t.token.address_hash.toLowerCase())),
  ];
  let listed = new Set<string>();
  let spamFilterAvailable = false;
  if (contracts.length > 0) {
    try {
      listed = await listedContracts(evmChainId, contracts);
      spamFilterAvailable = true;
    } catch {
      // swallowed — see comment above
    }
  }

  for (const row of tokens) {
    if (!row.total) continue; // an NFT transfer, not a fungible amount — no honest single "amount" to show
    // Defensive, not just tidy — a couple of the older Blockscout versions
    // this app talks to (Merlin, Metis) shape this payload slightly
    // differently already (see this file's own header comment), so a
    // missing field here is plausible; skip that one row rather than let
    // it throw and take down every other row this chain actually has.
    if (!row.token.address_hash || !row.from?.hash || !row.to?.hash) continue;
    if (spamFilterAvailable && !listed.has(row.token.address_hash.toLowerCase())) continue;
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

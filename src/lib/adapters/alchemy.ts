import "server-only";
import { fetchWithRetry } from "./http";
import { ETHERSCAN_EXPLORERS } from "./etherscan";
import { BLOCKSCOUT_HOSTS } from "./blockscout";
import { listedContracts } from "./tokenListing";
import type { AdapterTransaction } from "./types";

const API_KEY = process.env.ALCHEMY_API_KEY;

/**
 * Alchemy's per-chain subdomain (`{subdomain}.g.alchemy.com/v2/{key}`).
 * Originally just "base", added after a real, live-confirmed gap:
 * Blockscout (blockscout.ts, this app's only other free source for Base —
 * Etherscan paywalls it, see etherscan.ts's FREE_TIER_UNSUPPORTED) failed
 * to index a real, user-reported swap 27 minutes after it happened, even
 * though Blockscout's own chain-tip indexing was current to within 17
 * seconds at the time — a gap on that specific transaction, not a general
 * lag.
 *
 * Only the networks where alchemy_getAssetTransfers actually answers
 * (checked live 2026-09-26 against every network this app tracks): the
 * others answer "EAPIs not enabled on specified network" (Mantle, opBNB, Sei,
 * Fraxtal, Mode, Metis, Cronos — the Transfers API isn't offered there) or
 * "not enabled for this app" (Taiko, Merlin, Chiliz), and are routed to
 * Etherscan or Blockscout by transactionDispatch.ts. A failure here throws,
 * so the dispatcher can try the chain's next source and never reads an
 * error as "no transactions".
 */
export const ALCHEMY_HOSTS: Record<string, string> = {
  base: "base-mainnet",
  arb: "arb-mainnet",
  linea: "linea-mainnet",
  eth: "eth-mainnet",
  matic: "polygon-mainnet",
  blast: "blast-mainnet",
  celo: "celo-mainnet",
  unichain: "unichain-mainnet",
  berachain: "berachain-mainnet",
  op: "opt-mainnet",
  zksync: "zksync-mainnet",
  scrl: "scroll-mainnet",
  zetachain: "zetachain-mainnet",
  ron: "ronin-mainnet",
  xdai: "gnosis-mainnet",
  bsc: "bnb-mainnet",
  avax: "avax-mainnet",
  rbh: "robinhood-mainnet",
  soneium: "soneium-mainnet",
  zora: "zora-mainnet",
};

// Public explorer URL per chain, for the tx-row "view on explorer" link —
// reuses ETHERSCAN_EXPLORERS'/BLOCKSCOUT_HOSTS' own values where a chain
// is already in either (those are just public webpages, independent of
// which API actually supplied the data), so this never duplicates a URL
// this app already knows. Genuinely new here (no prior source covered
// them at all): Robinhood Chain, Chiliz, Cronos, Soneium — each URL
// verified live, not assumed from training data.
const EXTRA_EXPLORER_BASE: Record<string, string> = {
  rbh: "https://robinhoodchain.blockscout.com",
  chiliz: "https://chiliscan.com",
  // cronoscan.com was deprecated 2025-10-06 in favor of Cronos's own
  // explorer — live-verified this is the current official one, not the
  // more commonly-cached older URL.
  cronos: "https://explorer.cronos.com",
  soneium: "https://soneium.blockscout.com",
  zora: "https://explorer.zora.energy",
};

function explorerBaseFor(evmChainId: string): string {
  const etherscan = ETHERSCAN_EXPLORERS[evmChainId]?.base;
  if (etherscan) return etherscan;
  const blockscoutHost = BLOCKSCOUT_HOSTS[evmChainId];
  if (blockscoutHost) return `https://${blockscoutHost}`;
  return EXTRA_EXPLORER_BASE[evmChainId] ?? "";
}

// Same fiat/NFT-adjacent noise this app already excludes elsewhere —
// Alchemy's own category enum, not fetched at all (never asked for
// erc721/erc1155/specialnft — this app only tracks fungible value moves,
// same scope as etherscan.ts/blockscout.ts). "internal" deliberately left
// out too — real bug, caught live: Alchemy hard-rejects it as an
// unsupported category on several networks (Arbitrum, Optimism, zkSync all
// throw "category not supported for this network" rather than just
// omitting it), which took every transaction on those chains down with it.
// Dropping it isn't a regression — neither Etherscan's txlist nor
// Blockscout's /transactions endpoint ever captured contract-mediated
// "internal" value moves either, so every chain's coverage stays exactly
// what it already was.
const CATEGORIES = ["external", "erc20"];
const MAX_COUNT_HEX = "0x64"; // 100, same "most recent N, not paginated further" cap as etherscan.ts/blockscout.ts

interface AlchemyTransfer {
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null; // already decimal-adjusted by Alchemy, unlike Etherscan/Blockscout's raw base units
  asset: string | null;
  category: string;
  rawContract: { address: string | null };
  blockNum: string; // hex
  // Null despite withMetadata:true on several networks — Scroll, zkSync,
  // Linea and Avalanche return it null for every transfer (checked
  // 2026-09-26). Skipping those rows left those chains with no history at
  // all, so the block's time is looked up instead (blockTimes below).
  metadata: { blockTimestamp: string } | null;
}

/** Block number (hex) → ISO time, for transfers Alchemy returned without
 * metadata: one JSON-RPC batch of eth_getBlockByNumber per 50 blocks on the
 * same network. Throws on any failure (the chain then tries its next source). */
async function blockTimes(host: string, blockNums: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(blockNums)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const res = await fetchWithRetry(`https://${host}.g.alchemy.com/v2/${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch.map((b, j) => ({ jsonrpc: "2.0", id: j, method: "eth_getBlockByNumber", params: [b, false] }))),
    });
    if (!res.ok) throw new Error(`Alchemy (${host}) block times: HTTP ${res.status}`);
    const body = (await res.json()) as { id: number; result?: { timestamp: string } | null; error?: { message: string } }[];
    for (const r of Array.isArray(body) ? body : []) {
      if (r.result?.timestamp) out.set(batch[r.id], new Date(Number(BigInt(r.result.timestamp)) * 1000).toISOString());
    }
    const missing = batch.filter((b) => !out.has(b));
    if (missing.length > 0) throw new Error(`Alchemy (${host}) block times: ${missing.length} block(s) not returned`);
  }
  return out;
}

async function call(host: string, method: string, params: unknown[]): Promise<AlchemyTransfer[]> {
  const res = await fetchWithRetry(`https://${host}.g.alchemy.com/v2/${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Alchemy (${host}) failed: HTTP ${res.status}`);
  const body: { result?: { transfers: AlchemyTransfer[] }; error?: { message: string } } = await res.json();
  if (body.error) throw new Error(`Alchemy (${host}) error: ${body.error.message}`);
  return body.result?.transfers ?? [];
}

/**
 * Native + ERC-20 transfers for an address via alchemy_getAssetTransfers —
 * one request per direction (the API only ever filters by fromAddress OR
 * toAddress, never both at once, live-confirmed), deduped by Alchemy's own
 * `uniqueId` since a genuine self-transfer would otherwise appear in both
 * result sets. Unlike Etherscan/Blockscout, Alchemy pre-resolves both the
 * decimal-adjusted amount and the token symbol server-side — no separate
 * metadata/decimals lookup needed here.
 *
 * Same CoinGecko-listing spam filter as etherscan.ts/blockscout.ts, same
 * reasoning and same known false-positive tradeoff (documented there) —
 * Alchemy's own `asset` field is just as unfiltered as Etherscan/
 * Blockscout's token symbol, so an unsolicited airdrop-spam token shows up
 * here exactly the same way and needs the same gate.
 */
export async function fetchAlchemyTransactions(
  evmChainId: string,
  address: string,
  nativeSymbol: string,
): Promise<AdapterTransaction[]> {
  const host = ALCHEMY_HOSTS[evmChainId];
  if (!host || !API_KEY) return [];
  const lower = address.toLowerCase();
  const explorerBase = explorerBaseFor(evmChainId);

  const baseParams = {
    category: CATEGORIES,
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: MAX_COUNT_HEX,
    order: "desc",
  };
  // A failure throws (a network whose Transfers API isn't on, a network
  // error): the dispatcher tries the chain's next source, and if none works
  // keeps its saved history. It used to return [], which the sync read as
  // "no transactions" and erased the chain's rows (2026-09-26).
  const [outgoing, incoming] = await Promise.all([
    call(host, "alchemy_getAssetTransfers", [{ ...baseParams, fromAddress: address }]),
    call(host, "alchemy_getAssetTransfers", [{ ...baseParams, toAddress: address }]),
  ]);

  const byId = new Map<string, AlchemyTransfer>();
  for (const t of [...outgoing, ...incoming]) byId.set(t.uniqueId, t);
  const transfers = [...byId.values()];

  const tokenTransfers = transfers.filter((t) => t.category === "erc20");
  const contracts = [...new Set(tokenTransfers.map((t) => t.rawContract.address?.toLowerCase()).filter((a): a is string => !!a))];
  let listed = new Set<string>();
  let spamFilterAvailable = false;
  if (contracts.length > 0) {
    try {
      listed = await listedContracts(evmChainId, contracts);
      spamFilterAvailable = true;
    } catch {
      // fails open — see etherscan.ts's identical guard's own reasoning
    }
  }

  const times = await blockTimes(host, transfers.filter((t) => !t.metadata).map((t) => t.blockNum));

  const results: AdapterTransaction[] = [];
  for (const t of transfers) {
    const occurredAt = t.metadata?.blockTimestamp ?? times.get(t.blockNum);
    if (t.value === null || !t.from || !occurredAt) continue; // no honest amount/counterparty/timestamp to show
    const isNative = t.category === "external";
    if (!isNative) {
      const contract = t.rawContract.address?.toLowerCase();
      if (!contract) continue;
      if (spamFilterAvailable && !listed.has(contract)) continue;
    }

    const from = t.from.toLowerCase();
    const to = t.to?.toLowerCase() ?? null;
    const direction = to === lower && from === lower ? "self" : to === lower ? "in" : from === lower ? "out" : "unknown";

    results.push({
      txHash: t.hash,
      chain: evmChainId,
      occurredAt,
      direction,
      ticker: isNative ? nativeSymbol : t.asset,
      amount: t.value,
      counterparty: direction === "out" ? t.to : t.from,
      explorerUrl: `${explorerBase}/tx/${t.hash}`,
      // Alchemy's asset-transfers response carries no gas/fee data — left
      // unknown rather than adding a second per-tx receipt call just for
      // this purely-informational field (same "missing is honest" choice
      // etherscan.ts/blockscout.ts already make for a transfer's non-payer
      // leg).
      fee: null,
    });
  }

  return results;
}

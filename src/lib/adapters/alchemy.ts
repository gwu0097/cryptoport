import "server-only";
import { fetchWithRetry } from "./http";
import { EVM_CHAINS } from "./evmChains";
import { ETHERSCAN_EXPLORERS } from "./etherscan";
import { BLOCKSCOUT_HOSTS } from "./blockscout";
import { fetchTokenPrices } from "./coingecko";
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
 * Expanded to every EVM chain this app tracks that Alchemy actually
 * supports (29 of 32 — live-verified subdomain-by-subdomain, cross-checked
 * against Alchemy's own published network list), a deliberate choice made
 * after discussing the tradeoff directly: this consolidates every chain
 * onto one provider/budget instead of keeping Etherscan (proven reliable,
 * genuinely independent free tier) as a separate fallback for the 13
 * chains it already covered without issue. transactionDispatch.ts's own
 * priority order still tries Etherscan/Blockscout for anything NOT listed
 * here, so that fallback isn't deleted, just no longer reached for any
 * chain currently in EVM_CHAINS.
 *
 * Not supported by Alchemy at all (confirmed against its own network
 * list, not just a failed guess): PulseChain, Manta, Kava — these three
 * have no transaction-history source of any kind today.
 *
 * IMPORTANT: many of these networks return a real "X_MAINNET is not
 * enabled for this app" error until enabled in the Alchemy dashboard (App
 * → Networks) — this list assumes every needed network gets turned on
 * there; fetchAlchemyTransactions below returns an empty array (a
 * transaction-fetch failure, not a hard sync failure — see evm.ts's own
 * soft-failure treatment) for a chain that isn't enabled yet, same as one
 * with no coverage at all, rather than throwing.
 */
export const ALCHEMY_HOSTS: Record<string, string> = {
  base: "base-mainnet",
  arb: "arb-mainnet",
  linea: "linea-mainnet",
  eth: "eth-mainnet",
  matic: "polygon-mainnet",
  blast: "blast-mainnet",
  celo: "celo-mainnet",
  mnt: "mantle-mainnet",
  opbnb: "opbnb-mainnet",
  sei: "sei-mainnet",
  taiko: "taiko-mainnet",
  unichain: "unichain-mainnet",
  berachain: "berachain-mainnet",
  fraxtal: "frax-mainnet",
  op: "opt-mainnet",
  zksync: "zksync-mainnet",
  scrl: "scroll-mainnet",
  mode: "mode-mainnet",
  zetachain: "zetachain-mainnet",
  metis: "metis-mainnet",
  merlin: "merlin-mainnet",
  ron: "ronin-mainnet",
  xdai: "gnosis-mainnet",
  bsc: "bnb-mainnet",
  avax: "avax-mainnet",
  rbh: "robinhood-mainnet",
  chiliz: "chiliz-mainnet",
  cronos: "cronos-mainnet",
  soneium: "soneium-mainnet",
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
  // Nullable despite withMetadata:true in the request — real bug, caught
  // live: zkSync returned metadata: null for at least one real transfer.
  // No other field this app reads is documented or observed to have the
  // same gap, but this one genuinely does.
  metadata: { blockTimestamp: string } | null;
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
  let outgoing: AlchemyTransfer[];
  let incoming: AlchemyTransfer[];
  try {
    [outgoing, incoming] = await Promise.all([
      call(host, "alchemy_getAssetTransfers", [{ ...baseParams, fromAddress: address }]),
      call(host, "alchemy_getAssetTransfers", [{ ...baseParams, toAddress: address }]),
    ]);
  } catch {
    // Real, live-hit case, not hypothetical: a network listed in
    // ALCHEMY_HOSTS but not yet enabled in the Alchemy dashboard (App →
    // Networks) throws "X_MAINNET is not enabled for this app" or "EAPIs
    // not enabled on specified network" — a real HTTP error, not an empty
    // result. transactionDispatch.ts's mapWithConcurrency has no per-item
    // catch of its own, so letting this propagate would fail every chain
    // in the same Promise.all, not just this one — same "one chain's
    // failure never takes down another's correctly-fetched data" rule
    // etherscan.ts/blockscout.ts already follow, just needed here too.
    return [];
  }

  const byId = new Map<string, AlchemyTransfer>();
  for (const t of [...outgoing, ...incoming]) byId.set(t.uniqueId, t);
  const transfers = [...byId.values()];

  const evmChain = EVM_CHAINS.find((c) => c.id === evmChainId);
  const tokenTransfers = transfers.filter((t) => t.category === "erc20");
  const contracts = [...new Set(tokenTransfers.map((t) => t.rawContract.address?.toLowerCase()).filter((a): a is string => !!a))];
  let priced = new Map<string, unknown>();
  let spamFilterAvailable = false;
  if (evmChain?.coingeckoPlatform && contracts.length > 0) {
    try {
      priced = await fetchTokenPrices(evmChain.coingeckoPlatform, contracts);
      spamFilterAvailable = true;
    } catch {
      // fails open — see etherscan.ts's identical guard's own reasoning
    }
  }

  const results: AdapterTransaction[] = [];
  for (const t of transfers) {
    if (t.value === null || !t.from || !t.metadata) continue; // no honest amount/counterparty/timestamp to show
    const isNative = t.category === "external";
    if (!isNative) {
      const contract = t.rawContract.address?.toLowerCase();
      if (!contract) continue;
      if (spamFilterAvailable && !priced.has(contract)) continue;
    }

    const from = t.from.toLowerCase();
    const to = t.to?.toLowerCase() ?? null;
    const direction = to === lower && from === lower ? "self" : to === lower ? "in" : from === lower ? "out" : "unknown";

    results.push({
      txHash: t.hash,
      chain: evmChainId,
      occurredAt: t.metadata.blockTimestamp,
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

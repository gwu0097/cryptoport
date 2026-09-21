import "server-only";
import { fetchWithRetry } from "./http";
import { EVM_CHAINS } from "./evmChains";
import { fetchTokenPrices } from "./coingecko";
import type { AdapterTransaction } from "./types";

const API_KEY = process.env.ALCHEMY_API_KEY;

/**
 * Alchemy's per-chain subdomain (`{subdomain}.g.alchemy.com/v2/{key}`) —
 * only "base" populated for now, added directly in response to a real,
 * live-confirmed gap: Blockscout (blockscout.ts, this app's only other
 * free source for Base — Etherscan paywalls it, see etherscan.ts's
 * FREE_TIER_UNSUPPORTED) failed to index a real, user-reported swap 27
 * minutes after it happened, even though Blockscout's own chain-tip
 * indexing was current to within 17 seconds at the time — a gap on that
 * specific transaction, not a general lag. Alchemy's free tier
 * (30M compute units/month, live-verified working with a real key against
 * this exact transaction — it had it, immediately) is now the higher-
 * priority source for any chain listed here; see transactionDispatch.ts
 * for how it's preferred over Etherscan/Blockscout. Not populated for
 * every chain Alchemy could plausibly cover — no reported gap anywhere
 * else yet, and each additional entry is a real API-budget cost for a
 * chain nobody's hit a problem on.
 */
export const ALCHEMY_HOSTS: Record<string, string> = {
  base: "base-mainnet",
};

// Same fiat/NFT-adjacent noise this app already excludes elsewhere —
// Alchemy's own category enum, not fetched at all (never asked for
// erc721/erc1155/specialnft — this app only tracks fungible value moves,
// same scope as etherscan.ts/blockscout.ts).
const CATEGORIES = ["external", "internal", "erc20"];
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
  metadata: { blockTimestamp: string }; // already ISO
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
  const explorerBase = "https://basescan.org"; // Base-specific public explorer — revisit if ALCHEMY_HOSTS ever grows beyond just "base"

  const baseParams = {
    category: CATEGORIES,
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: MAX_COUNT_HEX,
    order: "desc",
  };
  const [outgoing, incoming] = await Promise.all([
    call(host, "alchemy_getAssetTransfers", [{ ...baseParams, fromAddress: address }]),
    call(host, "alchemy_getAssetTransfers", [{ ...baseParams, toAddress: address }]),
  ]);

  const byId = new Map<string, AlchemyTransfer>();
  for (const t of [...outgoing, ...incoming]) byId.set(t.uniqueId, t);
  const transfers = [...byId.values()];

  const evmChain = EVM_CHAINS.find((c) => c.id === evmChainId);
  const tokenTransfers = transfers.filter((t) => t.category === "erc20");
  const contracts = [...new Set(tokenTransfers.map((t) => t.rawContract.address?.toLowerCase()).filter((a): a is string => !!a))];
  let priced = new Map<string, unknown>();
  let spamFilterAvailable = false;
  if (evmChain && contracts.length > 0) {
    try {
      priced = await fetchTokenPrices(evmChain.coingeckoPlatform, contracts);
      spamFilterAvailable = true;
    } catch {
      // fails open — see etherscan.ts's identical guard's own reasoning
    }
  }

  const results: AdapterTransaction[] = [];
  for (const t of transfers) {
    if (t.value === null || !t.from) continue; // no honest amount/counterparty to show
    const isNative = t.category === "external" || t.category === "internal";
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

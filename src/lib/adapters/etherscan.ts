import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterTransaction } from "./types";

const API_BASE = "https://api.etherscan.io/v2/api";
const API_KEY = process.env.ETHERSCAN_API_KEY;

/**
 * Live-verified against api.etherscan.io/v2/chainlist (62 chains total):
 * only these of this app's 25 EVM_CHAINS entries are covered by
 * Etherscan's unified V2 API — Scroll, zkSync Era, Manta, Mode, Merlin,
 * ZetaChain, Metis, Ronin, PulseChain, Cronos, Kava, and Chiliz/Soneium
 * (no holdings on those last few yet) have no coverage here at all.
 * transactionSync.ts skips a wallet's holdings on an uncovered chain
 * rather than calling an endpoint that would just error — see the
 * /transactions feature's own coverage research for the numbers (covers
 * ~79% of this app's actual EVM holdings by count at the time this was
 * written). Keyed by this app's own EVM_CHAINS `id`, not the numeric
 * chainId, since that's what every other call site already has on hand.
 */
export const ETHERSCAN_EXPLORERS: Record<string, { chainId: number; base: string }> = {
  eth: { chainId: 1, base: "https://etherscan.io" },
  op: { chainId: 10, base: "https://optimistic.etherscan.io" },
  bsc: { chainId: 56, base: "https://bscscan.com" },
  xdai: { chainId: 100, base: "https://gnosisscan.io" },
  unichain: { chainId: 130, base: "https://uniscan.xyz" },
  matic: { chainId: 137, base: "https://polygonscan.com" },
  opbnb: { chainId: 204, base: "https://opbnb.bscscan.com" },
  fraxtal: { chainId: 252, base: "https://fraxscan.com" },
  sei: { chainId: 1329, base: "https://seiscan.io" },
  mnt: { chainId: 5000, base: "https://mantlescan.xyz" },
  base: { chainId: 8453, base: "https://basescan.org" },
  arb: { chainId: 42161, base: "https://arbiscan.io" },
  celo: { chainId: 42220, base: "https://celoscan.io" },
  avax: { chainId: 43114, base: "https://snowscan.xyz" },
  linea: { chainId: 59144, base: "https://lineascan.build" },
  berachain: { chainId: 80094, base: "https://berascan.com" },
  blast: { chainId: 81457, base: "https://blastscan.io" },
  taiko: { chainId: 167000, base: "https://taikoscan.io" },
};

interface EtherscanNativeRow {
  hash: string;
  from: string;
  to: string;
  value: string; // wei
  timeStamp: string; // unix seconds
  gasUsed: string;
  gasPrice: string;
  isError: string; // "0" | "1"
}

interface EtherscanTokenRow {
  hash: string;
  from: string;
  to: string;
  value: string; // raw, tokenDecimal units
  timeStamp: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

async function callEtherscan<T>(chainId: number, params: Record<string, string>): Promise<T[]> {
  if (!API_KEY) return [];
  const qs = new URLSearchParams({ chainid: String(chainId), apikey: API_KEY, ...params });
  const res = await fetchWithRetry(`${API_BASE}?${qs.toString()}`);
  if (!res.ok) throw new Error(`Etherscan (chain ${chainId}) failed: HTTP ${res.status}`);
  const body: { status: string; message: string; result: unknown } = await res.json();
  // status "0" covers both "genuinely nothing found" and a real failure
  // (bad key, rate limit) — Etherscan uses the same shape for both. Either
  // way this is exactly the "cosmetic, don't take down the rest of the
  // sync for one chain's hiccup" reasoning multicallEvm.ts already applies
  // to change24h/market cap: an empty result, never a thrown error.
  if (body.status === "0") return [];
  return Array.isArray(body.result) ? (body.result as T[]) : [];
}

const PAGE_SIZE = "100"; // most recent N — capped, not paginated further; see transactionSync.ts

/** Native-token transfers (ETH, BNB, MATIC, ...) plus ERC-20 transfers,
 * merged into one list — Etherscan's txlist only covers the former,
 * tokentx only the latter. Both calls scoped to `address` as either sender
 * or receiver (Etherscan's own semantics), so direction is exact, not
 * inferred. */
export async function fetchEvmTransactions(
  evmChainId: string,
  address: string,
  nativeSymbol: string,
): Promise<AdapterTransaction[]> {
  const explorer = ETHERSCAN_EXPLORERS[evmChainId];
  if (!explorer) return [];
  const lower = address.toLowerCase();

  const commonParams = {
    address,
    sort: "desc",
    page: "1",
    offset: PAGE_SIZE,
  };

  const [native, tokens] = await Promise.all([
    callEtherscan<EtherscanNativeRow>(explorer.chainId, { module: "account", action: "txlist", ...commonParams }),
    callEtherscan<EtherscanTokenRow>(explorer.chainId, { module: "account", action: "tokentx", ...commonParams }),
  ]);

  const results: AdapterTransaction[] = [];

  for (const row of native) {
    if (row.isError === "1") continue; // reverted — no real transfer happened, would show a misleading amount
    const from = row.from.toLowerCase();
    const to = row.to.toLowerCase();
    const direction = to === lower && from === lower ? "self" : to === lower ? "in" : from === lower ? "out" : "unknown";
    results.push({
      txHash: row.hash,
      chain: evmChainId,
      occurredAt: new Date(Number(row.timeStamp) * 1000).toISOString(),
      direction,
      ticker: nativeSymbol,
      amount: Number(row.value) / 1e18,
      counterparty: direction === "out" ? row.to : row.from,
      explorerUrl: `${explorer.base}/tx/${row.hash}`,
      fee: from === lower ? (Number(row.gasUsed) * Number(row.gasPrice)) / 1e18 : null,
    });
  }

  for (const row of tokens) {
    const from = row.from.toLowerCase();
    const to = row.to.toLowerCase();
    const direction = to === lower && from === lower ? "self" : to === lower ? "in" : from === lower ? "out" : "unknown";
    const decimals = Number(row.tokenDecimal) || 18;
    results.push({
      txHash: row.hash,
      chain: evmChainId,
      occurredAt: new Date(Number(row.timeStamp) * 1000).toISOString(),
      direction,
      ticker: row.tokenSymbol || null,
      amount: Number(row.value) / 10 ** decimals,
      counterparty: direction === "out" ? row.to : row.from,
      explorerUrl: `${explorer.base}/tx/${row.hash}`,
      fee: null, // gas is paid in the native token, not this one — the matching txlist row (same hash) already carries it
    });
  }

  return results;
}

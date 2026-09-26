import "server-only";
import { fetchWithRetry } from "./http";
import { etherscanFetch, isRateLimited } from "./etherscanFetch";
import { discoverAlchemyTokens, DISCOVERY_MAX_PAGES, type Discovery } from "./alchemyDiscovery";
import type { EvmChain } from "./evmChains";

// Which token contracts a wallet holds (or has held) on one chain, from the
// chain's discovery source (evmChains.ts `discovery`, docs/sync/PLAN.md D1).
// The sync then reads every one of them with its own balanceOf multicall, so a
// source only has to name contracts, never be trusted for amounts. All or
// nothing: any failure throws, and a result past the page cap is `capped` —
// either way the caller falls back to the registry scan for that chain (D4).
// Every source is capped at about the same ~1,000 tokens.
//
// Etherscan is additive, not a replacement: its free key allows 3 calls a
// second across the app, and a Sync all of 13 wallets × 6 Etherscan chains
// queued the last wallet 27 s when all ran at once (measured 2026-09-25). Sync
// all runs EVM wallets two at a time (SyncQueue.tsx LANE_CONCURRENCY): 12
// calls, ~4.2 s to drain, inside ETHERSCAN_MAX_WAIT_MS. So on Etherscan chains
// the registry scan still runs (`replacesRegistry` false), and a wallet whose
// turn is more than ETHERSCAN_MAX_WAIT_MS away skips discovery for that sync
// (a fallback in sync_runs) — listed tokens are still read, and last sync's
// tokens are always re-read, so only a brand-new unlisted token waits for a
// later sync.

export { DISCOVERY_MAX_PAGES, type Discovery };

const BLOCKSCOUT_MAX_PAGES = 20; // 50 tokens a page
const ETHERSCAN_PAGE = 1_000; // transfers a page
const ETHERSCAN_MAX_PAGES = 10; // Etherscan returns at most 10,000 records (page × offset)

const ETHERSCAN_MAX_WAIT_MS = 5_000;

const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * Blockscout's token list for an address (GET /api/v2/addresses/{a}/tokens,
 * ERC-20 only), every page. An address the explorer has never seen answers
 * 404 {"message":"Not found"}: no tokens, not an error.
 */
export async function discoverBlockscoutTokens(host: string, owner: string): Promise<Discovery> {
  const contracts = new Set<string>();
  let next: Record<string, string | number> | null = null;
  let pages = 0;
  do {
    if (pages === BLOCKSCOUT_MAX_PAGES) return { contracts: [...contracts], pages, capped: true };
    const qs = new URLSearchParams({ type: "ERC-20" });
    for (const [k, v] of Object.entries(next ?? {})) qs.set(k, String(v));
    const res = await fetchWithRetry(`https://${host}/api/v2/addresses/${owner}/tokens?${qs}`);
    pages++;
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (pages === 1 && body?.message === "Not found") return { contracts: [], pages, capped: false };
      throw new Error(`Blockscout ${host}: HTTP 404`);
    }
    if (!res.ok) throw new Error(`Blockscout ${host}: HTTP ${res.status}`);
    const body = (await res.json()) as { items?: { token?: { address_hash?: string; address?: string } }[]; next_page_params?: Record<string, string | number> | null };
    if (!Array.isArray(body.items)) throw new Error(`Blockscout ${host}: unexpected response`);
    for (const item of body.items) {
      const a = (item.token?.address_hash ?? item.token?.address ?? "").toLowerCase();
      if (ADDRESS.test(a)) contracts.add(a);
    }
    next = body.next_page_params ?? null;
  } while (next);
  return { contracts: [...contracts], pages, capped: false };
}

/**
 * Every ERC-20 contract the address has sent or received on this chain,
 * from Etherscan's transfer history (module=account&action=tokentx — the
 * free tier has no current-balance endpoint; addresstokenbalance is API Pro).
 * A token received and later sent away is read and found empty, which is
 * fine. More than 10,000 transfers can't be paged on the free tier: capped.
 */
export async function discoverEtherscanTokens(chainId: number, owner: string): Promise<Discovery> {
  const contracts = new Set<string>();
  for (let page = 1; page <= ETHERSCAN_MAX_PAGES; page++) {
    const body = await etherscanFetch(chainId, {
      module: "account",
      action: "tokentx",
      address: owner,
      page: String(page),
      offset: String(ETHERSCAN_PAGE),
      sort: "asc",
    }, { maxWaitMs: ETHERSCAN_MAX_WAIT_MS });
    if (body.status !== "1") {
      if (body.message === "No transactions found") return { contracts: [...contracts], pages: page, capped: false };
      throw new Error(`Etherscan (chain ${chainId}): ${isRateLimited(body) ? "rate limited" : String(body.result ?? body.message).slice(0, 120)}`);
    }
    const rows = Array.isArray(body.result) ? (body.result as { contractAddress?: string }[]) : [];
    for (const r of rows) {
      const a = (r.contractAddress ?? "").toLowerCase();
      if (ADDRESS.test(a)) contracts.add(a);
    }
    if (rows.length < ETHERSCAN_PAGE) return { contracts: [...contracts], pages: page, capped: false };
  }
  return { contracts: [...contracts], pages: ETHERSCAN_MAX_PAGES, capped: true };
}

/** Whether a chain's discovery lists every held token, so the registry scan
 * can be skipped when it succeeds (Alchemy, Blockscout: current balances), or
 * only adds to it (Etherscan: best-effort, see above). */
export function replacesRegistry(chain: EvmChain): boolean {
  return chain.discovery?.source === "alchemy" || chain.discovery?.source === "blockscout";
}

/** The chain's discovery, or null when it has no source (registry scan). */
export function discoverTokens(chain: EvmChain, owner: string): Promise<Discovery> | null {
  const d = chain.discovery;
  if (!d) return null;
  switch (d.source) {
    case "alchemy":
      return discoverAlchemyTokens(d.network, owner);
    case "blockscout":
      return discoverBlockscoutTokens(d.host, owner);
    case "etherscan":
      return discoverEtherscanTokens(chain.chainId, owner);
  }
}

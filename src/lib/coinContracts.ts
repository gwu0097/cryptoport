// Which token address a coin row copies when the row is a coin, not a
// holding (the Watchlist, the Encyclopedia) — owner 2026-10-06: "I keep
// finding tokens with no copy contract". Pure: the addresses that can be
// copied as they are, and which one a single button copies.
//
// Only addresses whose letter case doesn't matter or is known: EVM
// contracts from token_registry (stored lowercase, which an EVM address
// accepts), Solana and Sui ones from its `contract_exact` (as CoinGecko
// lists them; the lowercase `contract` is a different, wrong address and
// is never offered), and a `jup:<mint>` coin's own mint.

import { EVM_CHAINS } from "./adapters/evmChains.ts";
import { isTokenAddress } from "./assetContract.ts";

export interface CoinContract {
  chainId: string;
  chainName: string;
  contract: string;
}

const EVM_ORDER = new Map(EVM_CHAINS.map((c, i) => [c.id, i]));
const EVM_NAME = new Map(EVM_CHAINS.map((c) => [c.id, c.name]));
/** Chains whose addresses are case-sensitive: after the EVM chains. */
const EXACT_CHAINS = new Map([
  ["solana", { name: "Solana", order: -1 }],
  ["sui", { name: "Sui", order: EVM_CHAINS.length + 1 }],
]);

/** A coin key's own address: a `jup:<mint>` key is the mint itself. */
export function ownContract(coinKey: string): CoinContract | null {
  const mint = coinKey.startsWith("jup:") ? coinKey.slice(4) : null;
  return mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? { chainId: "solana", chainName: "Solana", contract: mint } : null;
}

/** token_registry rows to the addresses safe to copy — EVM contracts, and
 * Solana/Sui ones only from `contract_exact` (matching the lowercase key) —
 * Solana first (a coin listed there is usually native to it), then
 * evmChains.ts's order (Ethereum first), Sui last; each address once. */
export function copyableContracts(rows: readonly { chain_id: string; contract: string; contract_exact?: string | null }[]): CoinContract[] {
  const out: (CoinContract & { order: number })[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let c: (CoinContract & { order: number }) | null = null;
    if (EVM_ORDER.has(r.chain_id) && /^0x[0-9a-f]{40}$/i.test(r.contract)) {
      c = { chainId: r.chain_id, chainName: EVM_NAME.get(r.chain_id) ?? r.chain_id, contract: r.contract.toLowerCase(), order: EVM_ORDER.get(r.chain_id)! };
    } else {
      const exact = EXACT_CHAINS.get(r.chain_id);
      const addr = r.contract_exact?.trim();
      if (exact && addr && addr.toLowerCase() === r.contract.toLowerCase() && isTokenAddress(addr)) c = { chainId: r.chain_id, chainName: exact.name, contract: addr, order: exact.order };
    }
    if (!c || seen.has(`${c.chainId}:${c.contract}`)) continue;
    seen.add(`${c.chainId}:${c.contract}`);
    out.push(c);
  }
  return out.sort((a, b) => a.order - b.order).map((c) => ({ chainId: c.chainId, chainName: c.chainName, contract: c.contract }));
}

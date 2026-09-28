// Wallet Watch live activity on EVM chains (docs/wallet-watch/PLAN.md,
// phase 6): an Alchemy Address Activity delivery reduced to each watched
// owner's changes — the same rules as the history read
// (adapters/watchActivitySources.ts readEvmChain): outgoing negative,
// self-transfers skipped, the native coin from external and internal
// transfers, tokens by contract. NFTs and re-organized (removed) logs are
// skipped. Pure.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { RawChange } from "./watchActivity.ts";

/** Our chain id → Alchemy's network name, for the networks we watch live.
 * All three deliver internal transfers (a router's ETH payout on a sale),
 * per Alchemy's docs (checked 2026-09-28). */
export const WEBHOOK_NETWORKS: Readonly<Record<string, string>> = { eth: "ETH_MAINNET", arb: "ARB_MAINNET", rbh: "ROBINHOOD_MAINNET" };
const CHAIN_OF: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(WEBHOOK_NETWORKS).map(([c, n]) => [n, c]));

export interface AlchemyActivity {
  fromAddress?: string | null;
  toAddress?: string | null;
  hash?: string;
  value?: number | null;
  asset?: string | null;
  category?: string;
  erc721TokenId?: string | null;
  erc1155Metadata?: unknown;
  rawContract?: { rawValue?: string | null; address?: string | null; decimals?: number | null } | null;
  log?: { removed?: boolean } | null;
}

export interface AlchemyDelivery {
  webhookId?: string;
  createdAt?: string;
  type?: string;
  event?: { network?: string; activity?: AlchemyActivity[] } | null;
}

/** The HMAC-SHA256 of the raw body with the webhook's signing key, hex. */
export function validAlchemySignature(rawBody: string, signature: string, signingKey: string): boolean {
  const expected = createHmac("sha256", signingKey).update(rawBody, "utf8").digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function amount(a: AlchemyActivity): number | null {
  if (typeof a.value === "number") return a.value;
  const raw = a.rawContract?.rawValue;
  const decimals = a.rawContract?.decimals;
  if (!raw || typeof decimals !== "number") return null;
  const n = Number(BigInt(raw)) / 10 ** decimals;
  return Number.isFinite(n) ? n : null;
}

/** Each watched owner's changes in one delivery (owners and contracts
 * lowercased). An unknown network or a non-activity delivery is empty. */
export function alchemyChanges(delivery: AlchemyDelivery, watched: ReadonlySet<string>): Map<string, RawChange[]> {
  const out = new Map<string, RawChange[]>();
  const chain = CHAIN_OF[delivery.event?.network ?? ""];
  if (!chain || delivery.type !== "ADDRESS_ACTIVITY") return out;
  // No per-transfer time in the payload: the delivery's own.
  const at = new Date(delivery.createdAt ? Date.parse(delivery.createdAt) : Date.now()).toISOString();
  for (const a of delivery.event?.activity ?? []) {
    if (!a.hash || a.log?.removed) continue;
    if (a.erc721TokenId || a.erc1155Metadata || a.category === "erc721" || a.category === "erc1155") continue;
    const native = a.category === "external" || a.category === "internal";
    if (!native && ((a.category !== "token" && a.category !== "erc20") || !a.rawContract?.address)) continue;
    const qty = amount(a);
    if (qty === null || qty === 0) continue;
    const from = a.fromAddress?.toLowerCase() ?? null;
    const to = a.toAddress?.toLowerCase() ?? null;
    for (const owner of new Set([from, to])) {
      if (!owner || !watched.has(owner)) continue;
      if (from === to) continue; // a self-transfer moves nothing
      const outgoing = from === owner;
      const list = out.get(owner) ?? [];
      list.push({
        txId: a.hash,
        at,
        chain,
        contract: native ? null : a.rawContract!.address!.toLowerCase(),
        symbol: a.asset ?? (native ? "ETH" : null),
        qty: outgoing ? -qty : qty,
        counterparty: outgoing ? to : from,
      });
      out.set(owner, list);
    }
  }
  return out;
}

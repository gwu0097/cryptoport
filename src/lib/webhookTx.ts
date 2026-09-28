// Wallet Watch live activity (docs/wallet-watch/PLAN.md, phase 5): a raw
// Solana transaction, as a Helius "raw" webhook delivers it, reduced to the
// watched owner's net change per coin — the same rule as the history read
// (adapters/watchActivitySources.ts readSolana): SOL with the fee added
// back and wrapped SOL counted as SOL, tokens by mint. Pure.

import type { RawChange } from "./watchActivity.ts";

const WSOL = "So11111111111111111111111111111111111111112";

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** The fields we read from a raw transaction (getTransaction "json" shape). */
export interface RawWebhookTx {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: (string | { pubkey: string })[] } };
}

/** Every account key in order: the message's, then the lookup tables' writable
 * and read-only ones — the order pre/postBalances follow. */
export function accountKeys(tx: RawWebhookTx): string[] {
  const own = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey));
  return [...own, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
}

const units = (b: RawTokenBalance) => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;

/** The owner's net change per coin in one transaction. A failed transaction
 * moved nothing but its fee, which isn't activity: none. */
export function rawTxChanges(tx: RawWebhookTx, owner: string): RawChange[] {
  const meta = tx.meta;
  const txId = tx.transaction?.signatures?.[0];
  if (!meta || meta.err || !txId) return [];
  const at = new Date((tx.blockTime ?? 0) * 1000).toISOString();
  const keys = accountKeys(tx);

  let lamports = 0;
  const i = keys.indexOf(owner);
  if (i >= 0) lamports = (meta.postBalances?.[i] ?? 0) - (meta.preBalances?.[i] ?? 0);
  if (keys[0] === owner) lamports += meta.fee ?? 0; // the fee payer's fee isn't a trade

  // Token balances by account: post − pre, for accounts the owner holds.
  const byAccount = new Map<number, { mint: string; qty: number }>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.owner !== owner) continue;
    byAccount.set(b.accountIndex, { mint: b.mint, qty: -units(b) });
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.owner !== owner) continue;
    const cur = byAccount.get(b.accountIndex) ?? { mint: b.mint, qty: 0 };
    cur.qty += units(b);
    byAccount.set(b.accountIndex, cur);
  }
  const byMint = new Map<string, number>();
  for (const { mint, qty } of byAccount.values()) {
    if (mint === WSOL) lamports += qty * 1e9;
    else byMint.set(mint, (byMint.get(mint) ?? 0) + qty);
  }

  // The other side of a one-way token move, when exactly one other owner's
  // balance of that mint moved the opposite way (same-influencer netting).
  const counterpartyOf = (mint: string, qty: number): string | null => {
    const others = new Map<string, number>();
    for (const b of meta.postTokenBalances ?? []) if (b.mint === mint && b.owner && b.owner !== owner) others.set(b.owner, (others.get(b.owner) ?? 0) + units(b));
    for (const b of meta.preTokenBalances ?? []) if (b.mint === mint && b.owner && b.owner !== owner) others.set(b.owner, (others.get(b.owner) ?? 0) - units(b));
    const opposite = [...others].filter(([, d]) => d !== 0 && Math.sign(d) !== Math.sign(qty));
    return opposite.length === 1 ? opposite[0][0] : null;
  };

  const out: RawChange[] = [];
  if (lamports !== 0) out.push({ txId, at, chain: "solana", contract: null, symbol: "SOL", qty: lamports / 1e9, counterparty: null });
  for (const [mint, qty] of byMint) {
    if (qty !== 0) out.push({ txId, at, chain: "solana", contract: mint, symbol: null, qty, counterparty: counterpartyOf(mint, qty) });
  }
  return out;
}

/** Worth reading the database for: a swap (a coin out and another in, SOL
 * included), or anything sent out. A token that only arrived — the airdropped
 * spam that is most of a meme wallet's transactions — is skipped before any
 * request; a manual check still sees a real transfer in. */
export function worthSaving(changes: readonly RawChange[]): boolean {
  const meaningful = changes.filter((c) => c.contract !== null || Math.abs(c.qty) >= 0.005);
  const swap = meaningful.some((c) => c.qty > 0) && meaningful.some((c) => c.qty < 0);
  return swap || meaningful.some((c) => c.qty < 0);
}

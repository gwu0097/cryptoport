import "server-only";
import { fetchWithRetry } from "./http";
import { rawTxChanges, type RawWebhookTx } from "../webhookTx";

// One Solana token's history in one wallet, for its cost basis
// (costBasis.ts; owner 2026-10-16, alongside EVM). Never a whole-wallet scan
// (~3,300–7,700 Helius credits a busy month): the wallet's own account for
// that mint has its own signature list, so only the transactions that touched
// the token are read — the token accounts (1 call), their signatures (1 call
// per 1,000), then each transaction (1 credit each, batched). Each is reduced
// exactly as Wallet Watch reduces one (webhookTx.ts rawTxChanges: SOL with the
// fee added back, wrapped SOL as SOL, tokens by mint): what else left the
// wallet in a transaction that brought the token in is what was paid.

const KEY = process.env.HELIUS_API_KEY;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
/** Transactions read per request — the credit cap (one credit each). */
export const SOLANA_TX_CAP = 300;
const SIG_PAGE = 1000;
const BATCH = 50;

export interface SolanaPaidLeg {
  /** null: SOL. */
  mint: string | null;
  qty: number;
}

export interface SolanaCostEvent {
  at: string;
  txHash: string;
  /** Signed, in the token's units. */
  qty: number;
  paid: SolanaPaidLeg[];
}

async function rpc<T>(body: unknown): Promise<T> {
  const res = await fetchWithRetry(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (!res.ok) throw new Error(`Solana RPC: HTTP ${res.status}`);
  return (await res.json()) as T;
}

type One<T> = { result?: T; error?: { message: string } };

/** The token's movements in the wallet, each in with what was paid. Throws
 * when a read fails (never "no history"). `partial` when the history was
 * longer than the cap, or an older token account (closed, then reopened) may
 * hold earlier moves. */
export async function solanaCostEvents(owner: string, mint: string): Promise<{ events: SolanaCostEvent[]; partial: boolean }> {
  if (!KEY) throw new Error("Cost basis on Solana needs the Helius key");

  // The wallet's accounts for the mint (a filter by mint covers both token
  // programs, classic and Token-2022).
  const owned = await rpc<One<{ value: { pubkey: string }[] }>>({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint }, { encoding: "jsonParsed" }] });
  if (owned.error) throw new Error(`Solana RPC: ${owned.error.message}`);
  const accounts = (owned.result?.value ?? []).map((a) => a.pubkey);
  if (accounts.length === 0) return { events: [], partial: true };

  // Their signatures, newest first, up to the cap.
  const sigs: { signature: string; err: unknown }[] = [];
  let partial = false;
  for (const account of accounts) {
    let before: string | undefined;
    for (;;) {
      const r = await rpc<One<{ signature: string; err: unknown }[]>>({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [account, { limit: SIG_PAGE, ...(before ? { before } : {}) }] });
      if (r.error) throw new Error(`Solana RPC: ${r.error.message}`);
      const page = r.result ?? [];
      sigs.push(...page.filter((s) => !s.err));
      if (sigs.length >= SOLANA_TX_CAP) {
        partial = true;
        break;
      }
      if (page.length < SIG_PAGE) break;
      before = page[page.length - 1].signature;
    }
    if (partial) break;
  }
  const wanted = [...new Set(sigs.map((s) => s.signature))].slice(0, SOLANA_TX_CAP);

  // Each transaction, batched; reduced to the owner's net change per coin.
  const events: SolanaCostEvent[] = [];
  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH);
    const answers = await rpc<(One<RawWebhookTx> & { id: number })[]>(
      chunk.map((s, j) => ({ jsonrpc: "2.0", id: j, method: "getTransaction", params: [s, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] })),
    );
    for (const a of answers) {
      if (a.error) throw new Error(`Solana RPC: ${a.error.message}`);
      if (!a.result) continue;
      const changes = rawTxChanges(a.result, owner);
      const mine = changes.find((c) => c.contract === mint);
      if (!mine) continue;
      const paid = mine.qty > 0 ? changes.filter((c) => c !== mine && c.qty < 0).map((c) => ({ mint: c.contract, qty: -c.qty })) : [];
      events.push({ at: mine.at, txHash: mine.txId, qty: mine.qty, paid });
    }
  }
  return { events, partial };
}

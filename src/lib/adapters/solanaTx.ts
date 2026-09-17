import "server-only";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import { fetchTokenInfo } from "./jupiter";
import type { AdapterTransaction } from "./types";

// Two endpoints, deliberately not one — live-verified (2026-09) under this
// adapter's real call shape (16 getSignaturesForAddress + ~40
// getTransaction calls at concurrency 3, matching a real multi-token-
// account wallet sync): api.mainnet-beta.solana.com 429'd 36 of those 56
// calls, while PublicNode's Solana endpoint handled the identical burst
// with zero 429s. But PublicNode's free tier also flatly blocks
// getTokenAccountsByOwner ("Request blocked", verified against a real
// wallet address, not just an invalid-param error) — same restriction
// solanaRpc.ts's getProgramAccounts callers already ran into, so this
// isn't a one-off. Route accordingly: the one getTokenAccountsByOwner
// call this adapter makes per wallet (low volume, not the source of the
// 429s) stays on Solana's own public RPC; every getSignaturesForAddress/
// getTransaction call (the actual bulk, high-concurrency traffic) goes
// through PublicNode instead.
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const PUBLICNODE_RPC_URL = "https://solana-rpc.publicnode.com";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// Kept low and capped even against PublicNode's much higher tolerance —
// no reason to push it, and this still protects the getTokenAccountsByOwner
// call above, which stayed on the stricter original endpoint.
const RPC_CONCURRENCY = 3;
const SIGNATURE_LIMIT = 30; // per address (owner + each token account) scanned
const MAX_TOKEN_ACCOUNTS = 15; // caps how many of a wallet's token accounts get scanned for history
const EXPLORER_BASE = "https://solscan.io/tx";
const LAMPORTS_PER_SOL = 1_000_000_000;

async function rpc<T>(url: string, method: string, params: unknown[], context: string): Promise<T> {
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${context} failed: HTTP ${res.status}`);
  const json: { result?: T; error?: { message: string } } = await res.json();
  if (json.error) throw new Error(`${context} failed: ${json.error.message}`);
  return json.result as T;
}

interface SignatureInfo {
  signature: string;
  err: unknown;
}

interface TokenAccountRow {
  pubkey: string;
}

/** All of the owner's own SPL token accounts (ATAs and otherwise) — jsonRPC
 * hands these back directly rather than this app needing to derive the ATA
 * PDA itself, which is what makes scanning them for tx history tractable. */
async function getOwnedTokenAccounts(owner: string): Promise<string[]> {
  const result = await rpc<{ value: TokenAccountRow[] } | null>(
    SOLANA_RPC_URL, // PublicNode blocks this method on its free tier — see this file's own doc comment
    "getTokenAccountsByOwner",
    [owner, { programId: TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }],
    "getTokenAccountsByOwner",
  );
  return (result?.value ?? []).map((a) => a.pubkey);
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmount: number | null };
}

interface TxMeta {
  fee: number;
  err: unknown;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalanceEntry[];
  postTokenBalances?: TokenBalanceEntry[];
}

interface TxResult {
  blockTime: number | null;
  meta: TxMeta | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
}

function keyString(k: { pubkey: string } | string): string {
  return typeof k === "string" ? k : k.pubkey;
}

/** One "this asset changed by this much for this owner" leg, before a
 * ticker symbol has been resolved for its mint. */
interface RawLeg {
  signature: string;
  occurredAt: string;
  mint: string | "SOL";
  delta: number; // already decimal-adjusted (SOL or token ui amount)
}

/**
 * A wallet's Solana transaction history, merged from two sources: the
 * owner address's own signatures (covers anything it signed or was
 * directly referenced in) and each of its currently-held token accounts'
 * signatures (covers incoming SPL transfers, which land on the token
 * account rather than the owner and would otherwise be invisible — see
 * this feature's own research notes on that gap). Capped at
 * MAX_TOKEN_ACCOUNTS token accounts and SIGNATURE_LIMIT signatures per
 * address scanned, not a full history.
 *
 * A transaction's balance-delta approach (comparing pre/post balances for
 * whichever accounts belong to `owner`) is used instead of decoding
 * instructions — it's correct regardless of how complex the transaction is
 * (a plain transfer, a swap, a multi-step DeFi interaction), since Solana
 * always reports the net effect on every touched account's balance either
 * way. A transaction can produce more than one leg (e.g. a swap: token A
 * out, token B in) — each becomes its own AdapterTransaction row sharing
 * the same txHash, matching how the EVM adapter can also emit more than
 * one row per hash (native + token in the same tx).
 */
export async function fetchSolanaTransactions(owner: string): Promise<AdapterTransaction[]> {
  const tokenAccounts = (await getOwnedTokenAccounts(owner)).slice(0, MAX_TOKEN_ACCOUNTS);
  const addressesToScan = [owner, ...tokenAccounts];

  const sigLists = await mapWithConcurrency(addressesToScan, RPC_CONCURRENCY, (addr) =>
    rpc<SignatureInfo[]>(
      PUBLICNODE_RPC_URL,
      "getSignaturesForAddress",
      [addr, { limit: SIGNATURE_LIMIT }],
      "getSignaturesForAddress",
    ),
  );
  const uniqueSignatures = [
    ...new Set(sigLists.flat().filter((s) => !s.err).map((s) => s.signature)),
  ];

  const details = await mapWithConcurrency(uniqueSignatures, RPC_CONCURRENCY, async (signature) => {
    try {
      const tx = await rpc<TxResult | null>(
        PUBLICNODE_RPC_URL,
        "getTransaction",
        [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        "getTransaction",
      );
      return { signature, tx };
    } catch {
      return { signature, tx: null };
    }
  });

  const legs: RawLeg[] = [];

  for (const { signature, tx } of details) {
    if (!tx?.meta || tx.meta.err) continue;
    const occurredAt = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString();
    const keys = tx.transaction.message.accountKeys.map(keyString);
    const ownerIdx = keys.indexOf(owner);

    if (ownerIdx !== -1) {
      const netLamports = tx.meta.postBalances[ownerIdx] - tx.meta.preBalances[ownerIdx];
      // The fee payer (always account index 0) has it deducted from this
      // same balance regardless of direction — added back so the shown
      // amount is the actual transfer, not transfer-minus-fee.
      const adjusted = keys[0] === owner ? netLamports + tx.meta.fee : netLamports;
      if (adjusted !== 0) legs.push({ signature, occurredAt, mint: "SOL", delta: adjusted / LAMPORTS_PER_SOL });
    }

    const pre = new Map(
      (tx.meta.preTokenBalances ?? [])
        .filter((b) => b.owner === owner)
        .map((b) => [`${b.accountIndex}:${b.mint}`, b.uiTokenAmount.uiAmount ?? 0]),
    );
    const post = new Map(
      (tx.meta.postTokenBalances ?? [])
        .filter((b) => b.owner === owner)
        .map((b) => [`${b.accountIndex}:${b.mint}`, b.uiTokenAmount.uiAmount ?? 0]),
    );
    const mintsByKey = new Map(
      [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
        .filter((b) => b.owner === owner)
        .map((b) => [`${b.accountIndex}:${b.mint}`, b.mint]),
    );
    for (const key of new Set([...pre.keys(), ...post.keys()])) {
      const delta = (post.get(key) ?? 0) - (pre.get(key) ?? 0);
      if (delta !== 0) legs.push({ signature, occurredAt, mint: mintsByKey.get(key)!, delta });
    }
  }

  const mints = [...new Set(legs.map((l) => l.mint).filter((m) => m !== "SOL"))];
  const tokenInfo = mints.length > 0 ? await fetchTokenInfo(mints) : new Map();

  return legs.map((leg) => ({
    txHash: leg.signature,
    chain: "solana",
    occurredAt: leg.occurredAt,
    direction: leg.delta > 0 ? "in" : "out",
    ticker: leg.mint === "SOL" ? "SOL" : (tokenInfo.get(leg.mint)?.symbol ?? null),
    amount: Math.abs(leg.delta),
    // Solana's balance-delta approach doesn't identify the other party to
    // a transfer the way Etherscan's from/to columns do — left null (never
    // guessed) rather than picking an arbitrary other account touched by
    // what could be a many-account swap/DeFi instruction.
    counterparty: null,
    explorerUrl: `${EXPLORER_BASE}/${leg.signature}`,
    fee: null,
  }));
}

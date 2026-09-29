import "server-only";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import { ALCHEMY_HOSTS } from "./alchemy";
import type { LinkTransfer } from "../walletLinks";

// The transfers between a suggested wallet and a KOL's known wallets
// (walletLinks.ts judges them), read when the owner presses "Check links" on
// a suggestion — never automatically. EVM: Alchemy's transfers filtered by
// both ends, each direction, on the chains KOLs trade most (2 calls × 120 CU
// per known wallet per chain). Solana: the suggested wallet's last 100
// parsed transactions from Helius (1 call, 100 credits), scanned for the
// known wallets. A read that fails throws: "no link found" must mean the
// chain answered.

const EVM_CHAINS = ["eth", "arb", "base", "rbh", "op", "matic", "bsc"];

interface AlchemyTransfer {
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  metadata: { blockTimestamp: string } | null;
}

async function evmBetween(chain: string, from: string, to: string): Promise<LinkTransfer[]> {
  const res = await fetchWithRetry(`https://${ALCHEMY_HOSTS[chain]}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromAddress: from, toAddress: to, category: ["external", "erc20"], order: "desc", maxCount: "0x64", withMetadata: true, excludeZeroValue: true }] }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Alchemy (${chain}): HTTP ${res.status}`);
  const body: { result?: { transfers: AlchemyTransfer[] }; error?: { message: string } } = await res.json();
  if (body.error) throw new Error(`Alchemy (${chain}): ${body.error.message}`);
  return (body.result?.transfers ?? []).map((t) => ({ chain, from: t.from, to: t.to ?? "", asset: t.asset, value: t.value, at: t.metadata?.blockTimestamp ?? "", txId: t.hash }));
}

export async function evmLinkTransfers(known: readonly string[], suggested: string): Promise<LinkTransfer[]> {
  if (!process.env.ALCHEMY_API_KEY) throw new Error("Alchemy: no API key");
  const pairs = known.flatMap((k) => EVM_CHAINS.filter((c) => ALCHEMY_HOSTS[c]).flatMap((chain) => [{ chain, from: k, to: suggested }, { chain, from: suggested, to: k }]));
  return (await mapWithConcurrency(pairs, 3, (p) => evmBetween(p.chain, p.from, p.to))).flat();
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  transactionError: unknown;
  nativeTransfers?: { fromUserAccount: string | null; toUserAccount: string | null; amount: number }[];
  tokenTransfers?: { fromUserAccount: string | null; toUserAccount: string | null; mint: string; tokenAmount: number }[];
}

export async function solanaLinkTransfers(suggested: string): Promise<LinkTransfer[]> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("Helius: no API key");
  const res = await fetchWithRetry(`https://api-mainnet.helius-rpc.com/v0/addresses/${suggested}/transactions?api-key=${key}&limit=100`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Helius: HTTP ${res.status}`);
  const txs = (await res.json()) as HeliusTx[];
  if (!Array.isArray(txs)) throw new Error("Helius: unexpected answer");
  return txs
    .filter((t) => !t.transactionError)
    .flatMap((t) => {
      const at = new Date(t.timestamp * 1000).toISOString();
      return [
        ...(t.nativeTransfers ?? []).map((n) => ({ chain: "solana", from: n.fromUserAccount ?? "", to: n.toUserAccount ?? "", asset: "SOL", value: n.amount / 1e9, at, txId: t.signature })),
        ...(t.tokenTransfers ?? []).map((n) => ({ chain: "solana", from: n.fromUserAccount ?? "", to: n.toUserAccount ?? "", asset: `${n.mint.slice(0, 4)}…`, value: n.tokenAmount, at, txId: t.signature })),
      ];
    });
}

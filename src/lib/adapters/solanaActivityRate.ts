import "server-only";
import { fetchWithRetry } from "./http";
import { txPerMinute } from "../liveBudget";

// How busy a Solana address is (liveBudget.ts): its newest 1,000 signatures'
// times, from the public RPC — free, so checking never costs Helius credits
// (which may be the very thing that ran out).

export async function solanaTxPerMinute(address: string): Promise<number | null> {
  const res = await fetchWithRetry("https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, { limit: 1000 }] }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Solana RPC: HTTP ${res.status}`);
  const j = (await res.json()) as { result?: { blockTime: number | null }[]; error?: { message: string } };
  if (j.error) throw new Error(`Solana RPC: ${j.error.message}`);
  return txPerMinute((j.result ?? []).map((s) => s.blockTime ?? 0));
}

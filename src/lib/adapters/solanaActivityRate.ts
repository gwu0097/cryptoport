import "server-only";
import { fetchWithRetry } from "./http";
import { dayCount, LIVE_DAY_MAX } from "../liveBudget";

// A Solana address's last 24 hours of transactions (liveBudget.ts), from the
// free public RPC — so checking never costs Helius credits (which may be the
// very thing that ran out). Pages of 1,000 newest-first until a day back or
// past the limit (at most 11 pages).

const RPC = "https://api.mainnet-beta.solana.com";

async function page(address: string, before?: string): Promise<{ signature: string; blockTime: number | null }[]> {
  const res = await fetchWithRetry(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, { limit: 1000, ...(before ? { before } : {}) }] }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Solana RPC: HTTP ${res.status}`);
  const j = (await res.json()) as { result?: { signature: string; blockTime: number | null }[]; error?: { message: string } };
  if (j.error) throw new Error(`Solana RPC: ${j.error.message}`);
  return j.result ?? [];
}

export async function solanaDayCount(address: string): Promise<{ count: number; overLimit: boolean }> {
  const nowSec = Date.now() / 1000;
  const times: number[] = [];
  let before: string | undefined;
  for (let i = 0; i <= LIVE_DAY_MAX / 1000; i++) {
    const p = await page(address, before);
    for (const s of p) if (s.blockTime) times.push(s.blockTime);
    const oldest = p.at(-1)?.blockTime ?? 0;
    if (p.length < 1000 || oldest < nowSec - 86_400) return dayCount(times, nowSec, true);
    before = p.at(-1)!.signature;
  }
  return dayCount(times, nowSec, false);
}

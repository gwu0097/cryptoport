import "server-only";
import { fetchWithRetry } from "./http";
import { ALCHEMY_HOSTS } from "./alchemy";
import { dayCount, LIVE_DAY_MAX } from "../liveBudget";
import { WEBHOOK_NETWORKS } from "../alchemyWebhookTx";

// An EVM address's last 24 hours of transactions on the networks its live
// webhook covers (liveBudget.ts), from Alchemy's transfers (~150 compute
// units a page of 1,000; both directions, newest first, until a day back or
// past the limit). Only when going live, or when a receiver suspects a bot.

const KEY = process.env.ALCHEMY_API_KEY;

async function dayTimes(host: string, direction: "fromAddress" | "toAddress", address: string, nowSec: number): Promise<{ times: Map<string, number>; complete: boolean }> {
  const times = new Map<string, number>(); // one time per transaction (a swap is several transfers)
  let pageKey: string | undefined;
  for (let i = 0; i <= LIVE_DAY_MAX / 1000; i++) {
    const res = await fetchWithRetry(`https://${host}.g.alchemy.com/v2/${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [{ [direction]: address, category: ["external", "erc20"], order: "desc", maxCount: "0x3e8", withMetadata: true, excludeZeroValue: false, ...(pageKey ? { pageKey } : {}) }],
      }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Alchemy (${host}): HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { transfers: { hash: string; metadata?: { blockTimestamp?: string } }[]; pageKey?: string }; error?: { message: string } };
    if (body.error) throw new Error(`Alchemy (${host}): ${body.error.message}`);
    let oldest = Infinity;
    for (const t of body.result?.transfers ?? []) {
      const ts = t.metadata?.blockTimestamp ? Date.parse(t.metadata.blockTimestamp) / 1000 : 0;
      if (ts) {
        times.set(t.hash, ts);
        oldest = Math.min(oldest, ts);
      }
    }
    pageKey = body.result?.pageKey;
    if (!pageKey || oldest < nowSec - 86_400) return { times, complete: true };
  }
  return { times, complete: false };
}

/** The busiest webhook network's last 24 hours. */
export async function evmDayCount(address: string): Promise<{ count: number; overLimit: boolean }> {
  if (!KEY) throw new Error("Alchemy: no API key");
  const nowSec = Date.now() / 1000;
  let busiest = { count: 0, overLimit: false };
  for (const chain of Object.keys(WEBHOOK_NETWORKS)) {
    const host = ALCHEMY_HOSTS[chain];
    if (!host) continue;
    const from = await dayTimes(host, "fromAddress", address, nowSec);
    const to = await dayTimes(host, "toAddress", address, nowSec);
    const d = dayCount([...new Map([...from.times, ...to.times]).values()], nowSec, from.complete && to.complete);
    if (d.overLimit) return d;
    if (d.count > busiest.count) busiest = d;
  }
  return busiest;
}

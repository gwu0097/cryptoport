import "server-only";
import { fetchWithRetry } from "@/lib/adapters/http";

export interface PerpContext {
  /** Hourly funding rate (e.g. 0.0000125). */
  funding: number;
  /** Open interest in USD (Hyperliquid reports it in coins; × mark price). */
  openInterestUsd: number;
  markPx: number;
}

/** Funding and open interest for the named perps — one POST returns every
 * listed perp (live-verified 2026-09-22), no key, no per-asset calls. */
export async function fetchPerpContexts(coins: string[]): Promise<Map<string, PerpContext>> {
  const res = await fetchWithRetry("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) throw new Error(`Hyperliquid metaAndAssetCtxs failed: HTTP ${res.status}`);
  const [meta, ctxs]: [{ universe: { name: string }[] }, { funding?: string; openInterest?: string; markPx?: string }[]] =
    await res.json();
  const result = new Map<string, PerpContext>();
  for (const coin of coins) {
    const ctx = ctxs[meta.universe.findIndex((u) => u.name === coin)];
    const funding = Number(ctx?.funding);
    const oi = Number(ctx?.openInterest);
    const markPx = Number(ctx?.markPx);
    if (ctx && Number.isFinite(funding) && Number.isFinite(oi) && Number.isFinite(markPx)) {
      result.set(coin, { funding, openInterestUsd: oi * markPx, markPx });
    }
  }
  return result;
}

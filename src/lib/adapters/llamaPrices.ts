import "server-only";
import { fetchWithRetry, sequentialWithSpacing } from "./http";

// DefiLlama's coins service as the price refresh's fallback for CoinGecko
// coins (owner 2026-09-29): it takes CoinGecko's own ids
// ("coingecko:bitcoin"), no key, separate from CoinGecko's quota and its
// blocks — checked live the day CoinGecko's CloudFront refused every call
// from Vercel (8 of 8 held coins priced, down to STATICS and AEROBUD). It
// gives the price and its 24h change, not market cap or volume: those keep
// their stored values (the liquidity check reads them). Its limit isn't
// published; a ~700-request burst locked the screener out, serial calls
// 1.5 s apart never did — so calls here are serial and spaced.

const BASE = "https://coins.llama.fi";
const BATCH = 150;
const SPACING_MS = 1_500;
/** DefiLlama's own confidence in a price, 0–1; below this it's not used. */
const MIN_CONFIDENCE = 0.9;

export interface LlamaPrice {
  usd: number;
  change24h: number | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithRetry(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`DefiLlama: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Prices for CoinGecko ids, with their 24h change; ids it doesn't price
 * are left out. Throws when a call fails (never an empty answer). */
export async function fetchLlamaPrices(coingeckoIds: string[]): Promise<{ prices: Map<string, LlamaPrice>; calls: number }> {
  const batches: string[][] = [];
  for (let i = 0; i < coingeckoIds.length; i += BATCH) batches.push(coingeckoIds.slice(i, i + BATCH));
  // Two calls per batch (price, then 24h change), one at a time.
  const requests = batches.flatMap((b) => {
    const coins = b.map((id) => `coingecko:${encodeURIComponent(id)}`).join(",");
    return [
      { kind: "price" as const, url: `${BASE}/prices/current/${coins}` },
      { kind: "change" as const, url: `${BASE}/percentage/${coins}?period=24h` },
    ];
  });
  const results = await sequentialWithSpacing(requests, SPACING_MS, (r) => getJson<{ coins: Record<string, unknown> }>(r.url));
  const failed = results.find((r) => r.error);
  if (failed) throw failed.error!;
  const prices = new Map<string, LlamaPrice>();
  const changes = new Map<string, number>();
  for (const r of results) {
    for (const [coin, v] of Object.entries(r.result!.coins ?? {})) {
      const id = coin.replace(/^coingecko:/, "");
      if (r.item.kind === "change") {
        if (typeof v === "number" && Number.isFinite(v)) changes.set(id, v);
        continue;
      }
      const p = v as { price?: number; confidence?: number };
      if (typeof p.price === "number" && p.price > 0 && (p.confidence ?? 1) >= MIN_CONFIDENCE) prices.set(id, { usd: p.price, change24h: null });
    }
  }
  for (const [id, p] of prices) p.change24h = changes.get(id) ?? null;
  return { prices, calls: requests.length };
}

/** Prices at given moments (DefiLlama's batchHistorical: each coin with its
 * timestamps in one call — owner 2026-10-14, cost basis: what a buy paid, at
 * the time it was paid, years back). `coin` is DefiLlama's id
 * ("coingecko:ethereum"). Keyed `${coin}|${unixSeconds}`; a moment it can't
 * price (or prices with low confidence) is left out. Calls are serial and
 * spaced, ~40 moments each (the query is a JSON object in the URL). */
export async function fetchLlamaHistorical(points: readonly { coin: string; ts: number }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Map(points.map((p) => [`${p.coin}|${p.ts}`, p])).values()];
  const chunks: (typeof unique)[] = [];
  for (let i = 0; i < unique.length; i += 40) chunks.push(unique.slice(i, i + 40));
  await sequentialWithSpacing(chunks, SPACING_MS, async (chunk) => {
    const coins: Record<string, number[]> = {};
    for (const p of chunk) (coins[p.coin] ??= []).push(p.ts);
    const body = await getJson<{ coins?: Record<string, { prices?: { timestamp: number; price: number; confidence?: number }[] }> }>(
      `${BASE}/batchHistorical?coins=${encodeURIComponent(JSON.stringify(coins))}&searchWidth=600`,
    );
    for (const [coin, tss] of Object.entries(coins)) {
      const answers = body.coins?.[coin]?.prices ?? [];
      // Each moment takes the answer nearest it (within the 10-minute search
      // width asked for) — never matched by position.
      for (const ts of tss) {
        let best: (typeof answers)[number] | null = null;
        for (const a of answers) if (Math.abs(a.timestamp - ts) <= 600 && (!best || Math.abs(a.timestamp - ts) < Math.abs(best.timestamp - ts))) best = a;
        if (best && Number.isFinite(best.price) && (best.confidence ?? 1) >= MIN_CONFIDENCE) out.set(`${coin}|${ts}`, best.price);
      }
    }
  });
  return out;
}

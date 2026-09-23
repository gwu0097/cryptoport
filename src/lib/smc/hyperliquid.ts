import "server-only";
import { cache } from "react";
import { fetchWithRetry } from "@/lib/adapters/http";
import type { Candle } from "./engine";

// Hyperliquid's public info API — free, no key. Signals are computed on the
// venue the user intends to trade on (BACKLOG: "SMC signal engine"), so the
// chart matches what an order would execute against. Live-verified
// 2026-09-22: candleSnapshot returns up to 5,000 candles per call (1h ≈ 208
// days; 4h/1d back to listing), candles open on the UTC hour, and the LAST
// candle returned is the still-forming one (the engine's completeness guard
// handles it).
const INFO_URL = "https://api.hyperliquid.xyz/info";

// Hyperliquid rate-limits /info by request weight per minute per IP, and a
// candleSnapshot's weight grows with the candles it returns. A 429 is
// usually cleared within seconds, so back off longer than the default.
const RETRY = { attempts: 4, baseDelayMs: 2000 };

async function info<T>(body: unknown): Promise<T> {
  const res = await fetchWithRetry(
    INFO_URL,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    RETRY,
  );
  if (!res.ok) throw new Error(`Hyperliquid info ${JSON.stringify(body).slice(0, 60)} failed: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Active (non-delisted) perp names, e.g. "BTC", "HYPE", "kPEPE". Deduped
 * per request (React cache) — the chart and the watchlist table both need it. */
export const fetchPerpNames = cache(async (): Promise<string[]> => {
  const meta = await info<{ universe: { name: string; isDelisted?: boolean }[] }>({ type: "meta" });
  return meta.universe.filter((u) => !u.isDelisted).map((u) => u.name);
});

export async function fetchCandles(coin: string, interval: "1h" | "4h" | "1d", startMs: number, endMs: number): Promise<Candle[]> {
  const rows = await info<{ t: number; o: string; h: string; l: string; c: string }[]>({
    type: "candleSnapshot",
    req: { coin, interval, startTime: startMs, endTime: endMs },
  });
  return rows
    .map((r) => ({ t: Math.floor(r.t / 1000), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
}

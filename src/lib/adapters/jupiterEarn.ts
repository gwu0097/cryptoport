import "server-only";
import { jupiterFetch } from "./jupiterFetch";
import { earnHoldings, type EarnPosition } from "../jupiterEarn";
import type { AdapterHolding } from "./types";

// A Solana wallet's Jupiter Earn deposits, from Jupiter's Lend API — one call
// per wallet per sync, through jupiterFetch's process-wide pacer (the key's
// 10 requests per ~10 s). Replaces the retired Portfolio API (jupiterEarn.ts,
// 2026-10-09). Throws on failure, so the wallet's last Earn rows are kept
// (carryForward) rather than read as "no deposits".

const URL_BASE = "https://api.jup.ag/lend/v1/earn/positions";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const HEADERS: Record<string, string> = JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};

export async function fetchJupiterEarn(address: string): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const res = await jupiterFetch(`${URL_BASE}?users=${encodeURIComponent(address)}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Jupiter Earn failed: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("Jupiter Earn: unexpected answer");
  return earnHoldings(body as EarnPosition[]);
}

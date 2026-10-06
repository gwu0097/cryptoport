import "server-only";
import { fetchWithRetry } from "./http";
import { parseFills, type Fill, type ScoutAccountState } from "../perpScout/entries";
import { parsePortfolio, type PortfolioSeries } from "../perpScout/portfolio";
import { createPacer } from "../perpScout/pacer";
import type { HyperliquidOrder } from "../tpsl";

// Perp Scout's reads of Hyperliquid (docs/perp-scout/PLAN.md), all free and
// keyless: per followed account the info API's portfolio (its record and the
// whole account's value), clearinghouseState, frontendOpenOrders and
// userFills, and allMids for Refresh prices. (The
// trader screen runs from scripts/diag/perp-scout-screen.mts, not the app.)
// The info API allows an IP 1,200 weight a minute; every call here goes
// through one pacer per instance kept under that (pacer.ts), so a scan slows
// down rather than gets refused.

const INFO_URL = "https://api.hyperliquid.xyz/info";
/** Below Hyperliquid's 1,200 so other features' calls from the same IP fit. */
const WEIGHT_PER_MINUTE = 1_000;

const pacer = createPacer(WEIGHT_PER_MINUTE);

async function info<T>(body: Record<string, unknown>, weight: number): Promise<T> {
  await pacer.reserve(weight);
  const res = await fetchWithRetry(INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { baseDelayMs: 2_000 });
  if (!res.ok) throw new Error(`Hyperliquid ${body.type}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Perps PnL history and the whole account's value (portfolio.ts). */
export async function fetchPortfolio(address: string): Promise<PortfolioSeries> {
  return parsePortfolio(await info<unknown>({ type: "portfolio", user: address }, 20));
}

/** The main perps market's account (HIP-3 markets aren't read). */
export function fetchAccountState(address: string): Promise<ScoutAccountState> {
  return info<ScoutAccountState>({ type: "clearinghouseState", user: address }, 2);
}

export function fetchOpenOrders(address: string): Promise<HyperliquidOrder[]> {
  return info<HyperliquidOrder[]>({ type: "frontendOpenOrders", user: address }, 20);
}

/** The latest fills (Hyperliquid returns at most 2,000) — each 20 returned
 * costs 1 more weight, booked after the answer. */
export async function fetchRecentFills(address: string): Promise<Fill[]> {
  const raw = await info<unknown[]>({ type: "userFills", user: address }, 20);
  if (Array.isArray(raw)) pacer.charge(Math.ceil(raw.length / 20));
  return parseFills(raw);
}

/** Every main-market perp's mid price, keyed by coin. One call, weight 2. */
export async function fetchMids(): Promise<Record<string, number>> {
  const raw = await info<Record<string, string>>({ type: "allMids" }, 2);
  const out: Record<string, number> = {};
  for (const [coin, px] of Object.entries(raw ?? {})) {
    const n = Number(px);
    // "@123" keys are spot pairs; perps are named.
    if (!coin.startsWith("@") && Number.isFinite(n) && n > 0) out[coin] = n;
  }
  return out;
}

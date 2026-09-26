import "server-only";
import { fetchWithRetry } from "./http";
import { lighterHoldings, poolSharePrice, type LighterAccount, type LighterPoolPrice } from "../lighter";
import type { AdapterHolding } from "./types";

// Lighter (lighter.xyz perps DEX): every account an Ethereum address owns, in
// one unauthenticated call (GET /account?by=l1_address). Pool shares are
// valued from /publicPoolsMetadata and spot coins from /assetDetails, only
// when the account has any. Free, no key; 60 requests/minute per IP
// (fetchWithRetry retries its 429 — Lighter also answers 405 when throttled,
// treated the same). An address with no Lighter account gets HTTP 400
// "account not found" (code 21100): no holdings, not an error. Pure
// conversion and the rules: ../lighter.ts. Verified live 2026-09-25.

const API = "https://mainnet.zklighter.elliot.ai/api/v1";

/** The protocol names Zerion uses for Lighter, skipped by the Zerion sync
 * (zerionDefi.ts NATIVELY_COVERED_PROTOCOLS) — this adapter owns it. */
export const ZERION_PROTOCOL_NAMES = ["lighter"];

async function getJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  let res = await fetchWithRetry(`${API}${path}`, { headers: { accept: "application/json" } });
  if (res.status === 405) {
    await new Promise((r) => setTimeout(r, 2_000));
    res = await fetchWithRetry(`${API}${path}`, { headers: { accept: "application/json" } });
  }
  const body = res.headers.get("content-type")?.includes("json") ? ((await res.json()) as T) : null;
  return { status: res.status, body };
}

/** Every Lighter perp market's MARK price (what Lighter computes unrealized
 * PnL with) and 24h change, in one orderBookDetails call, keyed by symbol
 * ("BTC", "1000TOSHI"). Used for open positions' live PnL (perpPositions.ts).
 * Checked live 2026-09-26: BTC mark 83,891.9 vs last trade 83,893.3. */
export async function fetchLighterPerpMarks(): Promise<Map<string, { usd: number; change24h: number | null }>> {
  type Details = { order_book_details?: { symbol: string; market_type: string; mark_price: string; daily_price_change: number | null }[] };
  const { status, body } = await getJson<Details>("/orderBookDetails");
  if (status !== 200 || !body?.order_book_details) throw new Error(`Lighter market details failed: HTTP ${status}`);
  const out = new Map<string, { usd: number; change24h: number | null }>();
  for (const m of body.order_book_details) {
    const usd = Number(m.mark_price);
    if (m.market_type !== "perp" || !Number.isFinite(usd) || usd <= 0) continue;
    out.set(m.symbol, { usd, change24h: typeof m.daily_price_change === "number" && Number.isFinite(m.daily_price_change) ? m.daily_price_change : null });
  }
  return out;
}

async function poolPrice(index: number): Promise<LighterPoolPrice | null> {
  type Pools = { public_pools?: { account_index: number; name: string; account_type: number; total_asset_value: string; total_spot_value: string; total_shares: number }[] };
  // The listing starts below `index`; the LIT staking pool only appears under filter=stake.
  for (const filter of ["all", "stake"]) {
    const { body } = await getJson<Pools>(`/publicPoolsMetadata?index=${index + 1}&limit=1&filter=${filter}`);
    const pool = body?.public_pools?.find((p) => p.account_index === index);
    if (!pool) continue;
    const usdPerShare = poolSharePrice(pool);
    if (usdPerShare === null) return null;
    return { name: pool.name || (pool.account_type === 4 ? "LIT Staking" : `Pool ${index}`), usdPerShare };
  }
  return null;
}

export async function fetchLighterHoldings(address: string): Promise<AdapterHolding[]> {
  const { status, body } = await getJson<{ code?: number; message?: string; accounts?: LighterAccount[] }>(
    `/account?by=l1_address&value=${address.toLowerCase()}&active_only=true`,
  );
  if (status === 400 && body?.code === 21100) return []; // no Lighter account
  if (status !== 200 || !body?.accounts) throw new Error(`Lighter account lookup failed: HTTP ${status}${body?.message ? ` (${body.message})` : ""}`);
  const accounts = body.accounts;

  const poolIndexes = [...new Set(accounts.flatMap((a) => (a.shares ?? []).filter((s) => s.shares_amount).map((s) => s.public_pool_index)))];
  const poolPrices = new Map<number, LighterPoolPrice>();
  for (const i of poolIndexes) {
    const p = await poolPrice(i);
    if (p) poolPrices.set(i, p);
  }

  const spotSymbols = new Set(accounts.flatMap((a) => (a.assets ?? []).filter((s) => Number(s.balance) > 0 && s.symbol.toUpperCase() !== "USDC").map((s) => s.symbol.toUpperCase())));
  const spotUsd = new Map<string, number>();
  if (spotSymbols.size > 0) {
    const { body: details } = await getJson<{ asset_details?: { symbol: string; index_price: string }[] }>("/assetDetails");
    for (const d of details?.asset_details ?? []) {
      const price = Number(d.index_price);
      if (spotSymbols.has(d.symbol.toUpperCase()) && Number.isFinite(price) && price > 0) spotUsd.set(d.symbol.toUpperCase(), price);
    }
  }

  return lighterHoldings(accounts, poolPrices, spotUsd);
}

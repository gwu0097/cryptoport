import "server-only";
import { fetchWithRetry } from "./http";
import { fetchTokenInfo } from "./jupiter";
import type { AdapterHolding } from "./types";

const API_BASE = "https://api.lulo.fi";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface LuloAccountResponse {
  totalUsdValue: number;
  lusdUsdBalance: number; // "Regular" pool, in USD
  pusdUsdBalance: number; // "Protected" pool, in USD
  maxWithdrawable?: {
    protected?: Record<string, number>;
    regular?: Record<string, number>;
  };
}

/**
 * Lulo (lulo.fi) — a Solana USDC lending product with two pools ("Protected"
 * and "Regular", different risk/yield tiers). Has a real, free, keyless GET
 * API (api.lulo.fi/v1/account.getAccount?owner=<address>) — confirmed live
 * against 11 of this app's own real SOL wallets: 10 returned an all-zero
 * response (no position, a real $0, not an error), one had a genuine
 * position (pusdUsdBalance $7.88), which is what the field mapping below
 * was verified against — maxWithdrawable.protected/regular are keyed by
 * mint and already human-readable (not raw base units), and for this
 * wallet the USDC amount and USD balance matched almost exactly, as
 * expected for a stablecoin.
 *
 * pools.getPoolMeta (a separate endpoint) shows Lulo also has exposure to
 * mSOL/bSOL/USDT/etc. through a broader "aggregator" product, but
 * account.getAccount only ever returned USDC-keyed fields for every wallet
 * tested — this adapter covers the confirmed, verified USDC product only;
 * the broader aggregator is out of scope unless it turns out to matter for
 * a real wallet.
 *
 * usd_override is set directly from Lulo's own reported USD balance (not
 * computed from qty × a ticker price) — the safest path, same as every
 * other DeFi position here that already knows its own USD value (Jupiter
 * Earn's single-asset case, Hyperliquid's pinned stablecoins). qty is
 * still populated from maxWithdrawable for display, but never drives the
 * valuation.
 */
export async function fetchLuloPositions(address: string): Promise<AdapterHolding[]> {
  const res = await fetchWithRetry(`${API_BASE}/v1/account.getAccount?owner=${address}`);
  if (!res.ok) throw new Error(`Lulo account lookup failed: HTTP ${res.status}`);
  const body: LuloAccountResponse = await res.json();

  const protectedUsd = body.pusdUsdBalance ?? 0;
  const regularUsd = body.lusdUsdBalance ?? 0;
  if (protectedUsd <= 0 && regularUsd <= 0) return []; // no Lulo position — a real $0, not an error

  const tokenInfo = await fetchTokenInfo([USDC_MINT]).catch(() => new Map()); // icon is cosmetic — never fail over it
  const icon = tokenInfo.get(USDC_MINT)?.icon ?? null;

  const holdings: AdapterHolding[] = [];
  if (protectedUsd > 0) {
    holdings.push({
      ticker: "USDC",
      qty: body.maxWithdrawable?.protected?.[USDC_MINT] ?? null,
      usd_override: protectedUsd,
      contract: USDC_MINT,
      category: "defi",
      chain: "solana-defi",
      icon_url: icon,
      protocol: "Lulo: Protected",
      protocol_url: "https://app.lulo.fi/",
    });
  }
  if (regularUsd > 0) {
    holdings.push({
      ticker: "USDC",
      qty: body.maxWithdrawable?.regular?.[USDC_MINT] ?? null,
      usd_override: regularUsd,
      contract: USDC_MINT,
      category: "defi",
      chain: "solana-defi",
      icon_url: icon,
      protocol: "Lulo: Regular",
      protocol_url: "https://app.lulo.fi/",
    });
  }
  return holdings;
}

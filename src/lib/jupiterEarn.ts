// Jupiter Earn (Jupiter Lend's supply side) positions as holdings. Pure.
//
// Read from Jupiter's Lend API (`GET /lend/v1/earn/positions?users=`) since
// its Portfolio API (`/portfolio/v1/positions`) was retired: absent from its
// docs and answering 503 to every request (2026-10-09). Each position is a
// deposit of one asset — recorded as that asset (SOL, USDC…), priced like any
// other coin, the same row the Portfolio API used to give. The jlToken
// receipt in the wallet isn't counted by the token scan (no price), so this
// is the only place the deposit counts.

import type { AdapterHolding } from "./adapters/types.ts";

export const JUPITER_EARN_PROTOCOL = "Jupiter Earn";
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

export interface EarnPosition {
  token?: {
    address?: string;
    symbol?: string;
    decimals?: number;
    assetAddress?: string;
    asset?: { address?: string; symbol?: string; uiSymbol?: string; decimals?: number; logoUrl?: string | null };
  };
  /** The deposit in the asset's base units (shares converted). */
  underlyingAssets?: string;
  shares?: string;
}

/** A wallet's Earn positions as holdings; empty ones are skipped. A position
 * whose amount or decimals can't be read is skipped too and named. */
export function earnHoldings(positions: readonly EarnPosition[]): { holdings: AdapterHolding[]; warnings: string[] } {
  const holdings: AdapterHolding[] = [];
  const warnings: string[] = [];
  for (const p of positions) {
    const raw = p.underlyingAssets ?? "0";
    if (!/^\d+$/.test(raw) || raw === "0") continue;
    const asset = p.token?.asset;
    const mint = asset?.address ?? p.token?.assetAddress ?? null;
    const decimals = asset?.decimals ?? p.token?.decimals;
    if (!mint || decimals === undefined) {
      warnings.push(`Jupiter Earn: a position in ${p.token?.symbol ?? "an unknown token"} couldn't be read`);
      continue;
    }
    const symbol = mint === WRAPPED_SOL ? "SOL" : (asset?.uiSymbol ?? asset?.symbol ?? p.token?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`);
    holdings.push({
      ticker: symbol,
      qty: Number(raw) / 10 ** decimals,
      usd_override: null,
      contract: mint,
      category: "defi",
      chain: "solana-defi",
      icon_url: asset?.logoUrl ?? null,
      protocol: JUPITER_EARN_PROTOCOL,
      protocol_url: `https://jup.ag/lend/earn?symbol=${encodeURIComponent(symbol)}&action=deposit`,
    });
  }
  return { holdings, warnings };
}

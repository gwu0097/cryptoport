// The only coins a sync may store at $1 per unit — a last-resort value used
// only when the coin's own price_key has no market price (valueHolding). Owner
// decision 2026-09-25: keep this fallback for stablecoins, and nothing else ever
// gets a $1 value; any other coin without a price shows "—". Each entry is a
// dollar stablecoin verified on its venue (Hyperliquid spot/perps USDC, USDT0,
// USDe; Polymarket's PUSD, 1:1 USDC-redeemable). Adding one needs the same check.
// Pure.

export const DOLLAR_FALLBACK_STABLECOINS: ReadonlySet<string> = new Set(["USDC", "USDT0", "USDE", "PUSD"]);

/** qty × $1 for a listed stablecoin, else null (never a guess). */
export function stablecoinFallbackUsd(ticker: string, qty: number): number | null {
  return DOLLAR_FALLBACK_STABLECOINS.has(ticker.toUpperCase()) ? qty : null;
}

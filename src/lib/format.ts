const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

/** Same explicit "+" convention as formatPercent (Intl's own formatting
 * only signs negatives) — for a delta like a 24h portfolio change, not a
 * plain total. formatUsd itself stays unsigned; nowhere else needs a "+". */
export function formatUsdSigned(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${usdFormatter.format(value)}`;
}

/** null covers both "no 24h data yet" and "not a number" — callers don't
 * need to distinguish those, both just show as "—". Explicit "+" on a
 * positive value since Intl's default formatting only signs negatives. */
export function formatPercent(value: number | string | null): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

const qtyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** Caps a holding's quantity to 4 decimal places for display — the raw
 * qty (e.g. 23.337519169) is what's stored/summed, this is only a display
 * rounding, same as formatUsd's own maximumFractionDigits. */
export function formatQty(value: number | string | null): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === null || !Number.isFinite(n)) return "—";
  return qtyFormatter.format(n);
}

// CoinGecko's `symbol` field (the only ticker-casing source this app has,
// see adapters/coingecko.ts) is always lowercase — there's no API that
// returns a token's conventional display casing. Most tickers are fine
// uppercased (BTC, ETH, USDC, AERO...), but a handful of liquid-staking /
// restaking derivatives are conventionally written with a lowercase
// prefix (weETH, stETH, wstETH...). No general rule reliably covers this
// (WBTC is all-caps despite the same "w + asset" shape as weETH), so this
// is a manually curated exception list, not a heuristic — extend it as
// more show up.
const TICKER_DISPLAY_OVERRIDES: Record<string, string> = {
  WEETH: "weETH",
  WEETHS: "weETHs",
  STETH: "stETH",
  WSTETH: "wstETH",
  RETH: "rETH",
  CBETH: "cbETH",
  CBBTC: "cbBTC",
  ANKRETH: "ankrETH",
  FRXETH: "frxETH",
  SFRXETH: "sfrxETH",
  OSETH: "osETH",
  SWETH: "swETH",
  METH: "mETH",
  PUFETH: "pufETH",
  ETHX: "ETHx",
};

export function formatTicker(ticker: string): string {
  return TICKER_DISPLAY_OVERRIDES[ticker.toUpperCase()] ?? ticker;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatStaleness(lastRefreshAt: string | null): string {
  if (!lastRefreshAt) return "never refreshed";
  const diffMs = Date.now() - new Date(lastRefreshAt).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

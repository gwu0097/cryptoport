const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

const priceSmallFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 4,
});

/** A per-unit price where sub-dollar precision matters (signal trigger
 * levels, small-cap tokens): 2 decimals from $1 up, 4 significant digits
 * below — $0.04123, not formatUsd's "$0.04". */
export function formatPrice(value: number): string {
  return Math.abs(value) >= 1 ? usdFormatter.format(value) : priceSmallFormatter.format(value);
}

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** For a number too large to read comfortably at full precision (market
 * cap) — $78.3B, not $78,317,412,904.11. Null covers "not available",
 * consistent with formatPercent's convention. */
export function formatCompactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return compactUsdFormatter.format(value);
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

/** An unsigned share of some total — deliberately not formatPercent (that
 * adds a "+" for positive deltas, which reads wrong for a plain
 * proportion like this). "—" when there's no priced total to divide by,
 * same missing-≠-0 rule as every other figure in this app — not "0.0%",
 * which would look like the thing is genuinely worthless. Moved here from
 * AssetsTable.tsx once CoinAllocationChart needed the identical logic. */
export function formatShare(value: number, total: number): string {
  if (total <= 0) return "—";
  return `${((value / total) * 100).toFixed(1)}%`;
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

/** A moment in time, in the user's display timezone (required — the server
 * runs in UTC, so an implicit zone silently showed UTC before). */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatStaleness(lastRefreshAt: string | null, nowMs: number = Date.now()): string {
  if (!lastRefreshAt) return "never refreshed";
  const diffMs = nowMs - new Date(lastRefreshAt).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Perplexity's Agent API bakes inline citation markers like "[web:16]" —
 * sometimes several back to back, e.g. "[web:16][web:49]" — directly into
 * the prose it returns for trend explanations and token analyses. They're
 * pure noise in this app's UI: every source they'd point to is already
 * listed underneath as a real, clickable link, so this strips them at
 * display time (not at write time, so already-cached rows clean up too,
 * with no backfill needed) rather than showing numbers with nothing to
 * click. Reported directly as part of "this is a wall of text." */
export function stripCitations(text: string): string {
  return text
    .replace(/\s*\[web:\d+\]/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

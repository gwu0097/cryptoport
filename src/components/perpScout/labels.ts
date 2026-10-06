// Small display helpers shared by Perp Scout's tables. Pure.

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const explorerUrl = (address: string) => `https://app.hyperliquid.xyz/explorer/address/${address}`;

/** The trader's HyperDash profile (positions, fills, PnL calendar). */
export const hyperdashUrl = (address: string) => `https://hyperdash.com/trader/${address}`;

/** A fraction as a signed percent ("+4.2%"), "—" when unknown. */
export function signedPct(x: number | null, digits = 1): string {
  if (x === null || !Number.isFinite(x)) return "—";
  return `${x > 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
}

/** A fraction as a plain share ("42%"), "—" when unknown. */
export function sharePct(x: number | null, digits = 0): string {
  if (x === null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export const toneOf = (x: number | null) => (x === null ? "" : x > 0 ? "text-positive" : x < 0 ? "text-negative" : "");

/** Sort that keeps unknowns last in either direction. */
export function compareNullable(a: number | string | null, b: number | string | null, dir: "asc" | "desc"): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const c = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : (a as number) - (b as number);
  return dir === "asc" ? c : -c;
}

/** "3h ago" / "4d ago" for a ms timestamp against a ms now. */
export function ago(ms: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

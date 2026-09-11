// Client-only localStorage helpers — no "use client" needed here (no
// hooks, no JSX), just plain functions imported only from client
// components (RecordRecentWallet.tsx writes, RecentWalletsNav.tsx reads).
// Every read/write is try/catch-wrapped, same privacy-mode/blocked-storage
// discipline as usePersistedState.ts.

const STORAGE_KEY = "cryptoport:recentWallets";
const MAX_RECENT = 4;

export interface RecentWallet {
  id: string;
  name: string;
}

export function readRecentWallets(): RecentWallet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentWallet[]) : [];
  } catch {
    return [];
  }
}

/** Moves `wallet` to the front (deduped by id, so revisiting one already
 * in the list re-ranks it rather than adding a duplicate) and caps the
 * list at MAX_RECENT — called once per wallet-detail-page visit, see
 * RecordRecentWallet.tsx. */
export function recordRecentWallet(wallet: RecentWallet): void {
  try {
    const rest = readRecentWallets().filter((w) => w.id !== wallet.id);
    const next = [wallet, ...rest].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort — nothing to fall back to, same as usePersistedState
  }
}

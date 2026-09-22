// Client-only localStorage helpers — no "use client" needed here (no
// hooks, no JSX), just plain functions imported only from client
// components. See recentWallets.ts's own doc comment for the same call.
//
// Dashboard's watchlist-movers filter remembers your last selection across
// visits — reported directly ("keep the last selected watchlist when
// clicking dashboard"). A single persisted value, not a list, so this is
// its own tiny module rather than reusing recentWallets.ts's namespaced
// multi-item history (built for "recent chips," a different shape).
// "all" is a real, explicitly-persisted value (not just "nothing stored
// yet") — choosing "All watchlists" after having a specific one selected
// must stick too, not silently fall back to whatever was stored before.
const STORAGE_KEY = "cryptoport:dashboardWatchlist";

export function readDashboardWatchlistPref(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeDashboardWatchlistPref(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Best-effort — a private window or blocked storage just means this
    // resets to "All" next visit instead of persisting, not a hard failure.
  }
}

// Client-only localStorage helpers — no "use client" needed here (no
// hooks, no JSX), just plain functions imported only from client
// components. Every read/write is try/catch-wrapped, same privacy-mode/
// blocked-storage discipline as usePersistedState.ts.
//
// Namespaced rather than one shared list: "recently viewed on
// wallets/[id]" and "recently selected in Analytics' wallet picker" are
// genuinely different histories — a wallet you keep checking performance
// on isn't necessarily one you keep opening the detail page for, and
// conflating them would make either list less useful as a shortcut.

const MAX_RECENT = 4;

export interface RecentWallet {
  id: string;
  name: string;
}

// "wallets" keeps its original, pre-namespacing key literal (rather than
// moving to the "cryptoport:recent:wallets" shape every other namespace
// gets) so this change doesn't silently wipe out lists already saved in
// someone's browser from before Analytics got its own namespace.
function storageKey(namespace: string): string {
  return namespace === "wallets" ? "cryptoport:recentWallets" : `cryptoport:recent:${namespace}`;
}

export function readRecentWallets(namespace: string): RecentWallet[] {
  try {
    const raw = localStorage.getItem(storageKey(namespace));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentWallet[]) : [];
  } catch {
    return [];
  }
}

export const RECENT_WALLETS_CHANGED_EVENT = "cryptoport:recent-wallets-changed";

/** Moves `wallet` to the front of `namespace`'s list (deduped by id, so
 * revisiting one already in the list re-ranks it rather than adding a
 * duplicate) and caps it at MAX_RECENT.
 *
 * Also dispatches a window event so CollapsibleNavItem can pick up the
 * change immediately: the `storage` event only fires in *other* tabs, not
 * the one that made the write, so without this the sidebar's "Recent"
 * list for a namespace whose recorder never changes `pathname` (Analytics
 * — see RecentWalletsNav.tsx) wouldn't update until the next navigation. */
export function recordRecentWallet(namespace: string, wallet: RecentWallet): void {
  try {
    const rest = readRecentWallets(namespace).filter((w) => w.id !== wallet.id);
    const next = [wallet, ...rest].slice(0, MAX_RECENT);
    localStorage.setItem(storageKey(namespace), JSON.stringify(next));
    window.dispatchEvent(new Event(RECENT_WALLETS_CHANGED_EVENT));
  } catch {
    // best-effort — nothing to fall back to, same as usePersistedState
  }
}

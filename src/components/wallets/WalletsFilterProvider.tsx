"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePersistedState } from "../usePersistedState";

const TAG_FILTER_STORAGE_KEY = "cryptoport:walletsTagFilter";

interface WalletsFilterValue {
  tagFilter: string[];
  setTagFilter: (tags: string[]) => void;
}

// Static, never mutated — the fallback for a consumer rendered with no
// provider above it (see useWalletsFilter's own doc comment on why that's
// a real, intentional case here, not a wiring bug).
const NO_FILTER: WalletsFilterValue = { tagFilter: [], setTagFilter: () => {} };

const WalletsFilterContext = createContext<WalletsFilterValue | null>(null);

/**
 * Shares the wallets-list tag filter between WalletsTable (which rows show)
 * and SyncAllWalletsButton (which wallets "Sync all" actually syncs) — the
 * two live far apart in the DOM (the button sits in wallets/page.tsx's
 * PageHeader, the table below it), both as children of the same Server
 * Component page, so a small Context is the natural way to share one piece
 * of client state between server-rendered siblings without restructuring
 * the page's layout. Wraps wallets/page.tsx's whole return, same
 * `usePersistedState`/storage key WalletsTable used to own directly — moved
 * here now that a second consumer needs it, rather than SyncAllWalletsButton
 * reaching into WalletsTable's own state.
 */
export function WalletsFilterProvider({ children }: { children: ReactNode }) {
  const [tagFilter, setTagFilter] = usePersistedState<string[]>(TAG_FILTER_STORAGE_KEY, []);
  return <WalletsFilterContext.Provider value={{ tagFilter, setTagFilter }}>{children}</WalletsFilterContext.Provider>;
}

/**
 * Falls back to "no filter" (NO_FILTER, a static no-op) when rendered with
 * no WalletsFilterProvider above it — deliberately, not a missing-wiring
 * guard. SyncAllWalletsButton is also rendered on the Portfolio page,
 * which has no tag-filter UI of its own at all (it's grouped by chain, not
 * a wallet list) — its "Sync all" button must always mean literally all,
 * never silently pick up whatever filter happens to be persisted from the
 * Wallets page's own localStorage key. Reading real filter state instead
 * requires being inside a real WalletsFilterProvider (wallets/page.tsx),
 * which is the only place that ever calls setTagFilter for real.
 */
export function useWalletsFilter(): WalletsFilterValue {
  return useContext(WalletsFilterContext) ?? NO_FILTER;
}

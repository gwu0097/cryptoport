"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readRecentWallets, RECENT_WALLETS_CHANGED_EVENT, type RecentWallet } from "@/lib/recentWallets";

const NAMESPACE = "trendFinderSearches";

/**
 * The direct fix for "switch tabs, come back, the last search is gone" —
 * the Trend Finder nav link always lands on the bare, param-less route
 * (same convention as Wallets/Analytics/Transactions' own top-level nav
 * link, which never remembers "the last one you looked at" either — see
 * RecentWalletsNav.tsx), so the way back isn't remembering the URL, it's
 * making the last few searches one click away again. Reuses the same
 * namespaced localStorage list Wallets/Analytics/Transactions already use
 * (see recentWallets.ts) rather than a new mechanism — recorded by
 * <RecordRecentWallet namespace="trendFinderSearches" maxRecent={5}> once
 * a seed resolves (trend-finder/page.tsx).
 *
 * Rendered unconditionally at the top of the page (both the empty picker
 * state and while viewing results) so it's available regardless of where
 * the visitor currently is, not just from the empty state.
 */
export function TrendRecentSearches() {
  const [recent, setRecent] = useState<RecentWallet[]>([]);

  useEffect(() => {
    // Synchronizing with an external system (localStorage) on mount, same
    // exception usePersistedState.ts's own identical effect documents.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecent(readRecentWallets(NAMESPACE));

    const onChange = () => setRecent(readRecentWallets(NAMESPACE));
    window.addEventListener(RECENT_WALLETS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(RECENT_WALLETS_CHANGED_EVENT, onChange);
  }, []);

  if (recent.length === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-fg-muted">Recent:</span>
      {recent.map((r) => (
        <Link
          key={r.id}
          href={`/trend-finder?id=${encodeURIComponent(r.id)}`}
          className="rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs text-fg-muted transition hover:border-accent hover:text-fg"
        >
          {r.name}
        </Link>
      ))}
    </div>
  );
}

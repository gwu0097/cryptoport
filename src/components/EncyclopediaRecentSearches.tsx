"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readRecentWallets, RECENT_WALLETS_CHANGED_EVENT, type RecentWallet } from "@/lib/recentWallets";

const NAMESPACE = "encyclopediaSearches";

/** Same "switch tabs, come back, the last search is gone" fix as
 * TrendRecentSearches — its own mirror rather than a generalized shared
 * component, matching this app's own existing precedent (Compare got its
 * own CompareRecentSearches instead of a parameterized TrendRecentSearches).
 * Recorded by <RecordRecentWallet namespace="encyclopediaSearches"> once a
 * token resolves (encyclopedia/page.tsx). */
export function EncyclopediaRecentSearches() {
  const [recent, setRecent] = useState<RecentWallet[]>([]);

  useEffect(() => {
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
          href={`/encyclopedia?id=${encodeURIComponent(r.id)}`}
          className="rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs text-fg-muted transition hover:border-accent hover:text-fg"
        >
          {r.name}
        </Link>
      ))}
    </div>
  );
}

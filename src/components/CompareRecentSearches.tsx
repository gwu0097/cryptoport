"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readRecentWallets, RECENT_WALLETS_CHANGED_EVENT, type RecentWallet } from "@/lib/recentWallets";

const NAMESPACE = "compareSearches";

/** A recorded pair's id is the composite "<baseId>:<compareId>" (see
 * ComparePage's own RecordRecentWallet call) — split back into the two
 * ids this page's URL actually needs. */
function parsePairId(id: string): { base: string; compare: string } | null {
  const sep = id.indexOf(":");
  if (sep === -1) return null;
  return { base: id.slice(0, sep), compare: id.slice(sep + 1) };
}

/**
 * Same fix, same reasoning as Trend Finder's own TrendRecentSearches (see
 * that file's doc comment) — "switch tabs, come back, the last comparison
 * is gone" — applied to /compare, reusing the identical namespaced-
 * localStorage mechanism (recentWallets.ts) under its own "compareSearches"
 * namespace so the two recent-lists never mix.
 */
export function CompareRecentSearches() {
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
      {recent.map((r) => {
        const pair = parsePairId(r.id);
        if (!pair) return null;
        return (
          <Link
            key={r.id}
            href={`/compare?base=${encodeURIComponent(pair.base)}&compare=${encodeURIComponent(pair.compare)}`}
            className="rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs text-fg-muted transition hover:border-accent hover:text-fg"
          >
            {r.name}
          </Link>
        );
      })}
    </div>
  );
}

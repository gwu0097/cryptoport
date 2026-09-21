"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { readRecentWallets } from "@/lib/recentWallets";

const NAMESPACE = "compareSearches";

/** Same fix, same reasoning as Trend Finder's own TrendLastSearchRedirect
 * (see that file's doc comment) — mounted only on the bare, param-less
 * /compare route; redirects to the last-viewed pair if one exists, leaving
 * the real empty state (two pickers) for a genuinely first visit. */
export function CompareLastSearchRedirect() {
  const router = useRouter();

  useEffect(() => {
    const recent = readRecentWallets(NAMESPACE);
    const sep = recent[0]?.id.indexOf(":") ?? -1;
    if (recent[0] && sep !== -1) {
      const base = recent[0].id.slice(0, sep);
      const compare = recent[0].id.slice(sep + 1);
      router.replace(`/compare?base=${encodeURIComponent(base)}&compare=${encodeURIComponent(compare)}`);
    }
  }, [router]);

  return null;
}

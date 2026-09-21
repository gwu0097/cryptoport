"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { readRecentWallets } from "@/lib/recentWallets";

const NAMESPACE = "encyclopediaSearches";

/** Same "land back on the last token, not a blank picker" fix as
 * TrendLastSearchRedirect — mirrored, not shared, per this app's own
 * existing Compare precedent. Only mounted on the bare, param-less landing
 * state. */
export function EncyclopediaLastSearchRedirect() {
  const router = useRouter();

  useEffect(() => {
    const recent = readRecentWallets(NAMESPACE);
    if (recent.length > 0) router.replace(`/encyclopedia?id=${encodeURIComponent(recent[0].id)}`);
  }, [router]);

  return null;
}

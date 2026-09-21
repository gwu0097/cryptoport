"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { CoinSearchResult } from "@/lib/adapters/coingecko";
import { CoinSearchInput } from "./CoinSearchInput";
import { searchCoinsAction } from "@/app/(app)/trend-finder/actions";

/** Picks one side of the /compare page's pair, preserving whatever's
 * already set on the other side via the URL — same "?id=" shareable-URL
 * pattern as TrendSeedPicker, just two independent params instead of one.
 * Reuses Trend Finder's own searchCoinsAction rather than a duplicate —
 * same "public market data, no requireUser()" reasoning applies
 * identically here. */
export function CompareCoinPicker({ paramKey, placeholder }: { paramKey: "base" | "compare"; placeholder: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleSelect(coin: CoinSearchResult | null) {
    if (!coin) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramKey, coin.id);
    router.push(`/compare?${params.toString()}`);
  }

  return <CoinSearchInput search={searchCoinsAction} onSelect={handleSelect} placeholder={placeholder} clearOnSelect />;
}

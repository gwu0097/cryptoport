"use client";

import { useRouter } from "next/navigation";
import type { CoinSearchResult } from "@/lib/adapters/coingecko";
import { CoinSearchInput } from "./CoinSearchInput";
import { searchCoinsAction } from "@/app/(app)/trend-finder/actions";

/** Navigates to ?id=<coingecko-id> on pick — same "a plain component can't
 * navigate itself, so a small client wrapper supplies the one bit of JS
 * that requires" shape as TransactionsWalletFilter. The picker always
 * yields a real CoinGecko id (never a bare ticker), which is what keeps
 * Trend Finder's seed unambiguous — see trend-finder/page.tsx's own doc
 * comment on why there's deliberately no ?ticker= fallback in v1. `mcap`
 * carries the current floor selection through so picking a new seed
 * doesn't reset it. */
export function TrendSeedPicker({ mcap }: { mcap?: string }) {
  const router = useRouter();

  function handleSelect(coin: CoinSearchResult | null) {
    if (!coin) return;
    const params = new URLSearchParams({ id: coin.id });
    if (mcap) params.set("mcap", mcap);
    router.push(`/trend-finder?${params.toString()}`);
  }

  return (
    <CoinSearchInput
      search={searchCoinsAction}
      onSelect={handleSelect}
      placeholder="Search a ticker or coin name (e.g. ARB, Arbitrum)…"
      clearOnSelect
    />
  );
}

"use client";

import { TotalValuePanel } from "../TotalValuePanel";
import { useWalletsFilter } from "./WalletsFilterProvider";
import { filterWallets } from "@/lib/walletTagFilter";

interface WalletForTotal {
  name: string;
  chain: string;
  address: string | null;
  notes: string | null;
  tags: { name: string }[];
  total: number;
  unpricedCount: number;
}

/**
 * The Wallets page's own "Total value" — reactive to the same tag filter
 * WalletsTable/SyncAllWalletsButton already share (see
 * WalletsFilterProvider's own doc comment): when a filter is active, this
 * shows the sum of just the filtered wallets (and their own unpriced-count),
 * not the grand total across every wallet — a filtered "$83,259.40 across 6
 * wallets" view showing a $441,166.24 headline next to it read as wrong,
 * not just uninteresting. No filter selected still shows the real grand
 * total, computed server-side (getWalletsWithTotals' own aggregate, not
 * re-derived here) — same fallback shape as SyncAllWalletsButton's own
 * "no filter = everything" default.
 */
export function WalletsTotalValue({
  wallets,
  grandTotal,
  grandUnpricedCount,
}: {
  wallets: WalletForTotal[];
  grandTotal: number;
  grandUnpricedCount: number;
}) {
  const { tagFilter, searchQuery } = useWalletsFilter();
  const filtered = tagFilter.length > 0 || searchQuery.trim() !== "" ? filterWallets(wallets, { tags: tagFilter, query: searchQuery }) : null;
  const total = filtered ? filtered.reduce((sum, w) => sum + w.total, 0) : grandTotal;
  const unpricedCount = filtered ? filtered.reduce((sum, w) => sum + w.unpricedCount, 0) : grandUnpricedCount;

  return (
    <TotalValuePanel total={total}>
      {unpricedCount > 0 && (
        <p className="mt-2 text-sm text-warning">
          {unpricedCount} holding{unpricedCount === 1 ? "" : "s"} unpriced and excluded from the total
        </p>
      )}
    </TotalValuePanel>
  );
}

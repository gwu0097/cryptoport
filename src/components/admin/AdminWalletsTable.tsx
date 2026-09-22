"use client";

import Link from "next/link";
import type { WalletWithTotal } from "@/lib/queries";
import { formatUsd } from "@/lib/format";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "name" | "chain" | "tags" | "mode" | "value";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:adminWalletsSort";
const DEFAULT_SORT: Sort = { key: "value", dir: "desc" };

function sortValue(wallet: WalletWithTotal, key: SortKey): number | string {
  switch (key) {
    case "name":
      return wallet.name;
    case "chain":
      return wallet.chain;
    case "tags":
      return wallet.tags.map((t) => t.name).join(", ");
    case "mode":
      return wallet.mode;
    case "value":
      return wallet.total;
  }
}

/**
 * A deliberately separate, minimal component from the real WalletsTable —
 * not that component with an added `readOnly` flag. WalletsTable hardcodes
 * imports of deleteWallet/updateWallet/syncWalletHoldings/
 * syncExchangeHoldings and renders live Edit/Delete/Sync controls per row;
 * threading a flag through all of that to suppress it would mean the
 * admin-only read path shares a component with, and adds conditional
 * complexity to, the one table every real user's own wallet management
 * depends on. This one is read-only by construction: it doesn't import a
 * single mutation function, so there is no path for a click here to ever
 * change another user's data — not "the button is hidden," there is no
 * button.
 *
 * Sortable via the same SortableHeader/usePersistedState pattern every
 * other table in this app uses (AssetsTable, WatchlistTable, HoldingsTable)
 * — see CLAUDE.md's UI conventions section: every table gets this by
 * default now, not as a one-off request per table.
 *
 * Each row still links through to `/admin/{userId}/wallets/{wallet.id}` —
 * reported directly: "I can peek at the wallets but I can't go into
 * them." That page is the same kind of read-only-by-construction reuse,
 * just for a single wallet's holdings/sync status instead of the list.
 */
export function AdminWalletsTable({ userId, wallets }: { userId: string; wallets: WalletWithTotal[] }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;

  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  const sorted = [...wallets].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr className={theadRowClass}>
            <SortableHeader label="Name" sortKeyValue="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Chain" sortKeyValue="chain" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader
              label="Tags"
              sortKeyValue="tags"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
            <SortableHeader
              label="Mode"
              sortKeyValue="mode"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
            <SortableHeader label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((wallet) => (
            <tr key={wallet.id} className={trClass}>
              <td className={tdClass}>
                <Link href={`/admin/${userId}/wallets/${wallet.id}`} className="hover:text-accent hover:underline">
                  {wallet.name}
                </Link>
              </td>
              <td className={tdClass}>
                <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">{wallet.chain}</span>
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                {wallet.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {wallet.tags.map((t) => (
                      <span key={t.id} className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                        {t.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-fg-muted">—</span>
                )}
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{wallet.mode}</td>
              <td className={`${tdClass} tabular-nums`}>{wallet.total > 0 ? formatUsd(wallet.total) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

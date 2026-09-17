"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowUp, ArrowDown, ChevronsUpDown, Search, X } from "lucide-react";
import type { WatchlistRow } from "@/lib/queries";
import { formatUsd, formatCompactUsd, formatPercent } from "@/lib/format";
import { TokenIcon } from "../TokenIcon";
import { inputClass } from "../ui/Field";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "../ui/table";
import { usePersistedState } from "../usePersistedState";
import { removeWatchlistItem } from "@/app/(app)/watchlist/actions";

export type SortKey = "ticker" | "price" | "change1h" | "change24h" | "change7d" | "change30d" | "marketCap";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

// See AssetsTable's own SORT_KEYS for why this is exported — same "let the
// page validate a URL sort param against what the component actually
// understands" reasoning, for the watchlist/page.tsx side of the same
// Dashboard "view all" link feature.
export const SORT_KEYS: readonly SortKey[] = [
  "ticker",
  "price",
  "change1h",
  "change24h",
  "change7d",
  "change30d",
  "marketCap",
];

const STORAGE_KEY = "cryptoport:watchlistSort";
const DEFAULT_SORT: Sort = { key: "marketCap", dir: "desc" };
const SHOW_EXTRA_CHANGES_KEY = "cryptoport:watchlistShowExtraChanges";

function sortValue(row: WatchlistRow, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return row.ticker.toLowerCase();
    case "price":
      return row.price ?? -Infinity;
    case "change1h":
      return row.change1h ?? -Infinity;
    case "change24h":
      return row.change24h ?? -Infinity;
    case "change7d":
      return row.change7d ?? -Infinity;
    case "change30d":
      return row.change30d ?? -Infinity;
    case "marketCap":
      return row.marketCap ?? -Infinity;
  }
}

// Same green/red/muted convention as AssetsTable's own ChangeCell — no
// color at all for null ("no data"), never treated as flat/zero.
function ChangeCell({ value }: { value: number | null }) {
  const className =
    value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} tabular-nums`}>{formatPercent(value)}</span>;
}

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ChevronsUpDown className="size-3 text-fg-muted/50" aria-hidden="true" />;
  return dir === "desc" ? (
    <ArrowDown className="size-3" aria-hidden="true" />
  ) : (
    <ArrowUp className="size-3" aria-hidden="true" />
  );
}

function Header({
  label,
  sortKeyValue,
  sortKey,
  sortDir,
  onSort,
  className = "",
}: {
  label: string;
  sortKeyValue: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  return (
    <th className={`${thClass} ${className}`}>
      <button type="button" onClick={() => onSort(sortKeyValue)} className="flex items-center gap-1 hover:text-fg">
        {label}
        <SortIcon active={sortKey === sortKeyValue} dir={sortDir} />
      </button>
    </th>
  );
}

/** Structural sibling of AssetsTable — same search/sort/persisted-column-
 * toggle shell — but market-data-only columns (no Qty/Wallets/Value: these
 * are coins being watched, not held) and a per-row remove instead of an
 * expandable per-wallet breakdown.
 *
 * `initialSort` — see AssetsTable's own doc comment for the full
 * reasoning (same "force-apply after usePersistedState's own rehydration
 * effect" shape, used by watchlist/page.tsx for the same Dashboard "view
 * all" link feature). */
export function WatchlistTable({ items, initialSort }: { items: WatchlistRow[]; initialSort?: Sort }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, initialSort ?? DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;

  useEffect(() => {
    if (initialSort) setSort(initialSort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showExtraChanges, setShowExtraChanges] = usePersistedState(SHOW_EXTRA_CHANGES_KEY, true);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  function handleRemove(id: string) {
    setPendingRemoval(id);
    startTransition(async () => {
      try {
        await removeWatchlistItem(id);
      } finally {
        setPendingRemoval(null);
      }
    });
  }

  const query = search.trim().toLowerCase();
  const filtered = query
    ? items.filter((r) => r.ticker.toLowerCase().includes(query) || r.name.toLowerCase().includes(query))
    : items;

  const sorted = [...filtered].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-3">
        <div className="relative max-w-sm flex-1">
          <Search
            className="pointer-events-none absolute left-7 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search watchlist…"
            className={`${inputClass} pl-9`}
          />
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={showExtraChanges}
            onChange={(e) => setShowExtraChanges(e.target.checked)}
            className="size-4 rounded border-border accent-accent"
          />
          Show 1h/7d/30d change
        </label>
      </div>

      {sorted.length === 0 ? (
        <p className="p-5 pt-0 text-center text-sm text-fg-muted">
          No coins match &ldquo;{search}&rdquo;.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr className={theadRowClass}>
                <Header label="Asset" sortKeyValue="ticker" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Header label="Price" sortKeyValue="price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                {showExtraChanges && (
                  <Header
                    label="1h"
                    sortKeyValue="change1h"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                    className={hideOnMobileClass}
                  />
                )}
                <Header
                  label="24h"
                  sortKeyValue="change24h"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                  className={hideOnMobileClass}
                />
                {showExtraChanges && (
                  <>
                    <Header
                      label="7d"
                      sortKeyValue="change7d"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                      className={hideOnMobileClass}
                    />
                    <Header
                      label="30d"
                      sortKeyValue="change30d"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                      className={hideOnMobileClass}
                    />
                  </>
                )}
                <Header
                  label="Market Cap"
                  sortKeyValue="marketCap"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                  className={hideOnMobileClass}
                />
                <th className={thClass}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.id} className={trClass}>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <TokenIcon ticker={row.ticker} url={row.imageUrl} />
                      <div>
                        <div className="font-medium text-fg">{row.ticker}</div>
                        <div className="text-xs text-fg-muted">{row.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className={`${tdClass} tabular-nums`}>{row.price !== null ? formatUsd(row.price) : "—"}</td>
                  {showExtraChanges && (
                    <td className={`${tdClass} ${hideOnMobileClass}`}>
                      <ChangeCell value={row.change1h} />
                    </td>
                  )}
                  <td className={`${tdClass} ${hideOnMobileClass}`}>
                    <ChangeCell value={row.change24h} />
                  </td>
                  {showExtraChanges && (
                    <>
                      <td className={`${tdClass} ${hideOnMobileClass}`}>
                        <ChangeCell value={row.change7d} />
                      </td>
                      <td className={`${tdClass} ${hideOnMobileClass}`}>
                        <ChangeCell value={row.change30d} />
                      </td>
                    </>
                  )}
                  <td className={`${tdClass} ${hideOnMobileClass} tabular-nums text-fg-muted`}>
                    {formatCompactUsd(row.marketCap)}
                  </td>
                  <td className={tdClass}>
                    <button
                      type="button"
                      onClick={() => handleRemove(row.id)}
                      disabled={pendingRemoval === row.id}
                      aria-label={`Remove ${row.ticker} from watchlist`}
                      className="rounded p-1 text-fg-muted hover:bg-negative/10 hover:text-negative disabled:opacity-50"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

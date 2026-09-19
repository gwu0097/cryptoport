"use client";

import { ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { thClass } from "./table";

export function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ChevronsUpDown className="size-3 text-fg-muted/50" aria-hidden="true" />;
  return dir === "desc" ? (
    <ArrowDown className="size-3" aria-hidden="true" />
  ) : (
    <ArrowUp className="size-3" aria-hidden="true" />
  );
}

/**
 * Shared sortable `<th>` button — extracted from AssetsTable.tsx and
 * WatchlistTable.tsx (which had identical copies of this and SortIcon)
 * once TrendPeerTable needed a third, per this repo's own stated
 * duplication threshold ("if two already exist, extract a shared
 * version rather than adding a third"). Generic over each table's own
 * sort-key union — every caller keeps its own exhaustive `sortValue()`
 * switch type-checked against its own key type, this just owns the
 * shared button/icon markup.
 */
export function SortableHeader<K extends string>({
  label,
  sortKeyValue,
  sortKey,
  sortDir,
  onSort,
  className = "",
}: {
  label: string;
  sortKeyValue: K;
  sortKey: K;
  sortDir: "asc" | "desc";
  onSort: (key: K) => void;
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

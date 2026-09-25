"use client";

import type { CoverageGap } from "@/lib/pricingCoverageQuery";
import { GAP_LABEL } from "@/lib/pricingCoverage";
import { formatQty } from "@/lib/format";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "cause" | "chain" | "ticker" | "holdings" | "users";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:pricingGapsSort";
const DEFAULT_SORT: Sort = { key: "holdings", dir: "desc" };

function sortValue(g: CoverageGap, key: SortKey): number | string {
  switch (key) {
    case "cause":
      return GAP_LABEL[g.cause];
    case "chain":
      return g.chain ?? "";
    case "ticker":
      return g.ticker;
    case "holdings":
      return g.holdings;
    case "users":
      return g.users;
  }
}

/** One row per unpriced asset (cause + chain + ticker + contract/coin). */
export function PricingGapsTable({ gaps }: { gaps: CoverageGap[] }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;

  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  const sorted = [...gaps].sort((a, b) => {
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
            <SortableHeader label="Why" sortKeyValue="cause" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Chain" sortKeyValue="chain" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
            <SortableHeader label="Asset" sortKeyValue="ticker" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Holdings" sortKeyValue="holdings" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Users" sortKeyValue="users" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((g) => (
            <tr key={`${g.cause}|${g.chain}|${g.ticker}|${g.ref}`} className={trClass}>
              <td className={`${tdClass} text-fg-muted`}>{GAP_LABEL[g.cause]}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">{g.chain ?? "—"}</span>
              </td>
              <td className={tdClass}>
                <div className="max-w-[16rem] truncate font-medium" title={g.ticker}>
                  {g.ticker}
                </div>
                <div className="max-w-[16rem] truncate text-xs text-fg-muted" title={g.ref ?? undefined}>
                  {g.ref ?? "—"} · {formatQty(g.qty)}
                </div>
              </td>
              <td className={`${tdClass} tabular-nums`}>{g.holdings}</td>
              <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{g.users}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

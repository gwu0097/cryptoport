"use client";

import type { ExchangeMappingRow } from "@/lib/exchangeMappingsQuery";
import { MATCH_LABEL, type MatchKind } from "@/lib/exchangeMappings";
import { formatQty, formatUsd } from "@/lib/format";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "venue" | "ticker" | "coin" | "match" | "value";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:exchangeMappingsSort";
const DEFAULT_SORT: Sort = { key: "match", dir: "desc" };

// "Review" first when sorted by match descending: the rows worth a look.
const MATCH_RANK: Record<MatchKind, number> = { canonical: 0, native: 1, "venue-list": 2, "venue-price": 3, override: 4, unpriced: 5, copied: 6 };
const MATCH_TONE: Record<MatchKind, string> = {
  canonical: "text-fg-muted",
  native: "text-fg-muted",
  "venue-list": "text-fg-muted",
  "venue-price": "text-fg-muted",
  override: "text-fg-muted",
  copied: "text-warning",
  unpriced: "text-negative",
};

const value = (r: ExchangeMappingRow) => (r.usd === null ? -1 : r.usd * r.qty);

function sortValue(r: ExchangeMappingRow, key: SortKey): number | string {
  switch (key) {
    case "venue":
      return r.venue;
    case "ticker":
      return r.ticker;
    case "coin":
      return r.coinName ?? r.priceKey ?? "";
    case "match":
      return MATCH_RANK[r.match];
    case "value":
      return value(r);
  }
}

/** Read-only: the mappings are shared across every user, so a wrong one is
 * reported and fixed centrally, not edited here. */
export function ExchangeMappingsTable({ rows }: { rows: ExchangeMappingRow[] }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;

  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  const sorted = [...rows].sort((a, b) => {
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
            <SortableHeader label="Exchange" sortKeyValue="venue" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
            <SortableHeader label="Ticker" sortKeyValue="ticker" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Priced as" sortKeyValue="coin" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Matched by" sortKeyValue="match" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={`${r.venue}|${r.ticker}`} className={trClass}>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">{r.venue}</span>
              </td>
              <td className={`${tdClass} font-medium`}>{r.ticker}</td>
              <td className={tdClass}>
                {r.priceKey ? (
                  <>
                    <div>{r.coinName ?? r.coinSymbol ?? r.priceKey}</div>
                    <div className="text-xs text-fg-muted">{r.priceKey}</div>
                  </>
                ) : (
                  <span className="text-fg-muted">—</span>
                )}
              </td>
              <td className={`${tdClass} ${MATCH_TONE[r.match]}`}>{MATCH_LABEL[r.match]}</td>
              <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                {r.usd === null ? <span className="text-fg-muted">—</span> : formatUsd(r.usd * r.qty)}
                <div className="text-xs text-fg-muted">{formatQty(r.qty)} {r.ticker}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

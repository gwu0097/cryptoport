"use client";

import { AlertTriangle, History } from "lucide-react";
import type { UniverseRow } from "@/lib/screener/queries";
import { formatCompactUsd, formatUsd, formatStaleness } from "@/lib/format";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "name" | "sector" | "price" | "marketCap" | "fdv" | "tvl" | "fees30d" | "revenue30d" | "holdersRevenue30d";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:screenerUniverseSort";
const DEFAULT_SORT: Sort = { key: "marketCap", dir: "desc" };

function sortValue(row: UniverseRow, key: SortKey): number | string {
  switch (key) {
    case "name":
      return row.name;
    case "sector":
      return row.sector ?? "";
    case "price":
      return row.priceUsd ?? -Infinity;
    case "marketCap":
      return row.marketCapUsd ?? -Infinity;
    case "fdv":
      return row.fdvUsd ?? -Infinity;
    case "tvl":
      return row.tvlUsd ?? -Infinity;
    case "fees30d":
      return row.fees30d ?? -Infinity;
    case "revenue30d":
      return row.revenue30d ?? -Infinity;
    case "holdersRevenue30d":
      return row.holdersRevenue30d ?? -Infinity;
  }
}

/** Per-unit USD cell — `—` for null (never 0, per the build prompt's own
 * "null is not zero" principle) rather than reusing formatUsd, which
 * requires a real number. */
function UsdCell({ value, compact = true }: { value: number | null; compact?: boolean }) {
  if (value === null) return <span className="text-fg-muted">—</span>;
  return <span className="tabular-nums">{compact ? formatCompactUsd(value) : formatUsd(value)}</span>;
}

/**
 * Phase 1's "read-only table view of the raw universe, so I can spot-check
 * values against defillama.com and coingecko.com" deliverable — sortable
 * per CLAUDE.md's default-sortable-table rule, but deliberately plain
 * otherwise (no filters, no drill-down, no grades) since those belong to
 * the real screener UI once Phase 3 has something to show. A conflict flag
 * (⚠) links each affected row back to why, rather than hiding the
 * disagreement — this table's whole purpose is spot-checking against the
 * two source sites, so a row DefiLlama and CoinGecko disagree on is
 * exactly the row worth seeing first, not last.
 */
export function ScreenerUniverseTable({ rows }: { rows: UniverseRow[] }) {
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
            <SortableHeader label="Asset" sortKeyValue="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader
              label="Sector"
              sortKeyValue="sector"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
            <SortableHeader label="Price" sortKeyValue="price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Market cap" sortKeyValue="marketCap" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader
              label="FDV"
              sortKeyValue="fdv"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
            <SortableHeader
              label="TVL"
              sortKeyValue="tvl"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
            <SortableHeader label="Fees (30d)" sortKeyValue="fees30d" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader
              label="Revenue (30d)"
              sortKeyValue="revenue30d"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortableHeader
              label="Holders rev. (30d)"
              sortKeyValue="holdersRevenue30d"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.assetId} className={trClass}>
              <td className={tdClass}>
                <div className="flex items-center gap-1.5">
                  {row.hasConflict && (
                    <AlertTriangle
                      className="size-3.5 shrink-0 text-warning"
                      aria-label="DefiLlama and CoinGecko disagree on this asset's market cap by more than the configured threshold"
                    />
                  )}
                  {row.isBackfilled && (
                    <History
                      className="size-3.5 shrink-0 text-fg-muted"
                      aria-label="Backfilled — not captured on the day it happened, see PHASE_0.md §6"
                    />
                  )}
                  <span className="font-medium text-fg">{row.name}</span>
                  <span className="text-fg-muted">({row.ticker})</span>
                </div>
                <div className="text-xs text-fg-muted">{row.geckoId}</div>
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{row.sector ?? "—"}</td>
              <td className={tdClass}>
                <UsdCell value={row.priceUsd} compact={false} />
              </td>
              <td className={tdClass}>
                <UsdCell value={row.marketCapUsd} />
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <UsdCell value={row.fdvUsd} />
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <UsdCell value={row.tvlUsd} />
              </td>
              <td className={tdClass}>
                <UsdCell value={row.fees30d} />
              </td>
              <td className={tdClass}>
                <UsdCell value={row.revenue30d} />
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <UsdCell value={row.holdersRevenue30d} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 0 && (
        <p className="mt-2 px-3 text-xs text-fg-muted">
          Snapshot observed {formatStaleness(rows[0].observedAt)}. ⚠ = source conflict, flagged not resolved. Clock
          icon = backfilled (see PHASE_0.md §6 for why backfilled history isn&rsquo;t treated as true point-in-time).
        </p>
      )}
    </div>
  );
}

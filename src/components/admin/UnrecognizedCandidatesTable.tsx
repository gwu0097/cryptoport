"use client";

import type { CoverageCandidate } from "@/lib/unrecognizedTokensQuery";
import { REASON_LABEL } from "@/lib/unrecognizedTokens";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";
import { TruncatedAddress } from "@/components/TruncatedAddress";

type SortKey = "symbol" | "chain" | "reason" | "wallets";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:unrecognizedCandidatesSort";
const DEFAULT_SORT: Sort = { key: "wallets", dir: "desc" };

function sortValue(r: CoverageCandidate, key: SortKey): number | string {
  switch (key) {
    case "symbol":
      return r.symbol.toLowerCase();
    case "chain":
      return r.chainName;
    case "reason":
      return r.reason;
    case "wallets":
      return r.wallets;
  }
}

/** Unrecognized tokens that don't look like spam, across every user — the
 * ones worth a look (a new CoinGecko listing, a receipt standard not read
 * yet). Read-only. */
export function UnrecognizedCandidatesTable({ rows }: { rows: CoverageCandidate[] }) {
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
            <SortableHeader label="Token" sortKeyValue="symbol" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Chain" sortKeyValue="chain" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Why" sortKeyValue="reason" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
            <SortableHeader label="Wallets" sortKeyValue="wallets" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <th className={`${thClass} ${hideOnMobileClass}`}>Contract</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={`${r.chain}|${r.contract}`} className={trClass}>
              <td className={`${tdClass} break-all`}>{r.symbol}</td>
              <td className={`${tdClass} text-fg-muted`}>{r.chainName}</td>
              <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{REASON_LABEL[r.reason]}</td>
              <td className={`${tdClass} tabular-nums`}>{r.wallets}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <TruncatedAddress address={r.contract} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

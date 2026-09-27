"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { WatchedInfluencer, WatchGroup } from "@/lib/watchQuery";
import { formatUsd } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";
import { AgeText } from "@/components/AgeText";

type SortKey = "name" | "value" | "refreshed";
type Sort = { key: SortKey; dir: "asc" | "desc" };

function sortValue(i: WatchedInfluencer, key: SortKey): number | string {
  switch (key) {
    case "name":
      return i.name.toLowerCase();
    case "value":
      return i.valueUsd ?? -Infinity;
    case "refreshed":
      return i.lastRefreshAt ? Date.parse(i.lastRefreshAt) : -Infinity;
  }
}

const FAMILY: Record<string, string> = { ETH: "EVM", SOL: "Solana", BTC: "Bitcoin" };

/** The watched influencers of the selected group, with what they hold now
 * (the last read's quantities at today's prices). */
export function WatchTable({ influencers, groups, serverNowSec }: { influencers: WatchedInfluencer[]; groups: WatchGroup[]; serverNowSec: number }) {
  const [sort, setSort] = usePersistedState<Sort>("cryptoport:walletWatchSort", { key: "value", dir: "desc" });
  const { key: sortKey, dir: sortDir } = sort;
  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const rows = [...influencers].sort((a, b) => {
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
            <SortableHeader label="Influencer" sortKeyValue="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <th className={`${thClass} ${hideOnMobileClass}`}>Top holdings</th>
            <th className={`${thClass} ${hideOnMobileClass}`}>Groups</th>
            <SortableHeader label="Last read" sortKeyValue="refreshed" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            const reading = i.addresses.some((a) => a.refreshStatus === "syncing");
            const failed = i.addresses.filter((a) => a.lastRefreshStatus?.startsWith("error:")).length;
            return (
              <tr key={i.id} className={trClass}>
                <td className={tdClass}>
                  <span className="flex items-center gap-1.5">
                    <Link href={`/wallet-watch/${i.id}`} className="font-medium text-fg hover:underline">
                      {i.name}
                    </Link>
                    {i.link && (
                      <a href={i.link} target="_blank" rel="noopener noreferrer" aria-label={`${i.name}'s profile`} className="text-fg-muted hover:text-fg">
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                  </span>
                  <div className="text-xs text-fg-muted">
                    {i.addresses.length} address{i.addresses.length === 1 ? "" : "es"} · {[...new Set(i.addresses.map((a) => FAMILY[a.chain] ?? a.chain))].join(", ")}
                  </div>
                </td>
                <td className={`${tdClass} tabular-nums`}>
                  {i.valueUsd === null ? (reading ? <span className="text-fg-muted">Reading…</span> : "—") : formatUsd(i.valueUsd)}
                  {i.unpricedCount > 0 && <div className="text-xs text-warning">{i.unpricedCount} unpriced</div>}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>
                  {i.topHoldings.length === 0 ? (
                    <span className="text-fg-muted">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {i.topHoldings.map((h) => (
                        <span key={h.ticker} className="whitespace-nowrap">
                          <span className="font-medium text-fg">{h.ticker}</span> <span className="text-fg-muted">{formatUsd(h.usd)}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} text-xs text-fg-muted`}>
                  {i.groupIds.length === 0 ? "—" : i.groupIds.map((g) => groupName.get(g)).filter(Boolean).join(", ")}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} text-xs text-fg-muted`}>
                  {reading ? "Reading now…" : <AgeText at={i.lastRefreshAt} serverNowSec={serverNowSec} />}
                  {failed > 0 && <div className="text-warning">{failed} address{failed === 1 ? "" : "es"} failed</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

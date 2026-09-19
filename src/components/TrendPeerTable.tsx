"use client";

import { ExternalLink } from "lucide-react";
import type { PeerRow } from "@/lib/trendFinder";
import { formatUsd, formatCompactUsd, formatPercent } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "./ui/table";
import { SortableHeader } from "./ui/SortableHeader";
import { usePersistedState } from "./usePersistedState";
import type { PeerSortKey, SortDirection } from "@/lib/sortKeys";

type Sort = { key: PeerSortKey; dir: SortDirection };

const STORAGE_KEY = "cryptoport:trendPeerSort";
// Ascending 24h (laggards first) is the whole point of Trend Finder — see
// trendFinder.ts's rankPeers, which already returns rows in this order.
// This is just the *initial* sort; usePersistedState below still lets a
// visitor's last choice win on repeat visits, same as every other
// sortable table in this app.
const DEFAULT_SORT: Sort = { key: "change24h", dir: "asc" };

function sortValue(peer: PeerRow, key: PeerSortKey): number | string {
  switch (key) {
    case "ticker":
      return peer.symbol.toLowerCase();
    case "price":
      return peer.price ?? -Infinity;
    case "change1h":
      return peer.change1h ?? -Infinity;
    case "change24h":
      return peer.change24h ?? -Infinity;
    case "change7d":
      return peer.change7d ?? -Infinity;
    case "marketCap":
      return peer.marketCap;
  }
}

function ChangeCell({ value }: { value: number | null }) {
  const className =
    value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} tabular-nums`}>{formatPercent(value)}</span>;
}

/** The sortable peer table for one Trend Finder tier — same sort-toggle
 * shell as AssetsTable/WatchlistTable (now sharing SortableHeader, see
 * that file's own doc comment), just without search or a remove action
 * since these rows aren't owned by the viewer. One instance per tier
 * (TierPanel in trend-finder/page.tsx renders one per category shown),
 * each with its own independent sort state — not a global table spanning
 * every tier, since "Tier 1" vs "Tier 2" is a meaningful grouping to keep
 * visually separate, not just two chunks of one bigger list. */
export function TrendPeerTable({ peers }: { peers: PeerRow[] }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;

  function toggleSort(key: PeerSortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  const sorted = [...peers].sort((a, b) => {
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
            <SortableHeader label="Asset" sortKeyValue="ticker" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader label="Price" sortKeyValue="price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader
              label="1h"
              sortKeyValue="change1h"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
            <SortableHeader label="24h" sortKeyValue="change24h" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            <SortableHeader
              label="7d"
              sortKeyValue="change7d"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              className={hideOnMobileClass}
            />
            <SortableHeader
              label="Market cap"
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
          {sorted.map((peer) => (
            <tr key={peer.id} className={trClass}>
              <td className={tdClass}>
                <div className="flex items-center gap-2">
                  <TokenIcon ticker={peer.symbol} url={peer.imageUrl} />
                  <span className="font-medium text-fg">{peer.symbol}</span>
                </div>
              </td>
              <td className={`${tdClass} tabular-nums`}>{peer.price !== null ? formatUsd(peer.price) : "—"}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <ChangeCell value={peer.change1h} />
              </td>
              <td className={tdClass}>
                <ChangeCell value={peer.change24h} />
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <ChangeCell value={peer.change7d} />
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} tabular-nums text-fg-muted`}>
                {formatCompactUsd(peer.marketCap)}
              </td>
              <td className={tdClass}>
                <a
                  href={`https://www.coingecko.com/en/coins/${peer.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on CoinGecko"
                  aria-label={`View ${peer.symbol} on CoinGecko`}
                  className="text-fg-muted transition hover:text-accent"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

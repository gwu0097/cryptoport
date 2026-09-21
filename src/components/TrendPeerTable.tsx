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
// sortable table in this app. Shared storage key across both of Trend
// Finder's peer tables (category + AI-suggested) — one sort preference for
// the page, matching v1's own multi-tier precedent, not a per-table one.
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
      return peer.marketCap ?? -Infinity;
  }
}

function ChangeCell({ value }: { value: number | null }) {
  const className =
    value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} tabular-nums`}>{formatPercent(value)}</span>;
}

/** The sortable peer table for one of Trend Finder v3's two peer sources
 * (CoinGecko category members, or AI-resolved narrative tickers — see
 * trend-finder/page.tsx) — same sort-toggle shell as AssetsTable/
 * WatchlistTable (sharing SortableHeader), just without search or a remove
 * action since these rows aren't owned by the viewer.
 *
 * `seedId` — when `peers` includes the seed's own row (page.tsx always
 * prepends it, per the direct ask: "whatever token is searched for, add
 * that token into the table too"), this marks which row it is so it
 * doesn't read as an unexplained duplicate. `confirmedIds` — ids present in
 * *both* peer sources get a "Confirmed by both" badge, per the direct ask:
 * "see if there's overlap and what isn't" between the two sources. */
export function TrendPeerTable({
  peers,
  seedId,
  confirmedIds,
}: {
  peers: PeerRow[];
  seedId?: string;
  confirmedIds?: Set<string>;
}) {
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
          {sorted.map((peer) => {
            const isSeed = peer.id === seedId;
            const isConfirmed = confirmedIds?.has(peer.id) ?? false;
            return (
              <tr key={peer.id} className={`${trClass} ${isSeed ? "bg-accent/10" : ""}`}>
                <td className={tdClass}>
                  <div className="flex items-center gap-2">
                    <TokenIcon ticker={peer.symbol} url={peer.imageUrl} />
                    <span className="font-medium text-fg">{peer.symbol}</span>
                    {isSeed && (
                      <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        Seed
                      </span>
                    )}
                    {!isSeed && isConfirmed && (
                      <span className="rounded-full bg-positive/20 px-1.5 py-0.5 text-[10px] font-medium text-positive">
                        Confirmed by both
                      </span>
                    )}
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

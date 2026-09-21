"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, ListPlus, BookOpen } from "lucide-react";
import Link from "next/link";
import type { PeerRow } from "@/lib/trendFinder";
import type { WatchlistSummary } from "@/lib/queries";
import { formatUsd, formatCompactUsd, formatPercent, stripCitations } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { TradingViewCompareChart } from "./TradingViewCompareChart";
import { WatchlistAddMenu } from "./WatchlistAddMenu";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "./ui/table";
import { SortableHeader } from "./ui/SortableHeader";
import { usePersistedState } from "./usePersistedState";
import type { PeerSortKey, SortDirection } from "@/lib/sortKeys";

function peerToCoin(peer: PeerRow) {
  return { coingeckoId: peer.id, ticker: peer.symbol, name: peer.name, imageUrl: peer.imageUrl };
}

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
 * "see if there's overlap and what isn't" between the two sources.
 * `reasons` — id -> the AI's own specific justification for that peer
 * (only ever passed for the AI-suggested table, never the CoinGecko-
 * category one, which has no per-row reason to show). `seedSymbol` — the
 * seed's own ticker, needed to build a TradingViewCompareChart against
 * every peer row. Every non-seed row gets an expand chevron: a reason (if
 * one exists) plus a live TradingView overlay chart of that peer against
 * the seed — reported directly: neither the flat peer list nor a single
 * correlation/24h-change number says whether a "laggard" actually moved
 * early or is genuinely behind, which the overlaid chart shows directly.
 * The standalone `/compare` page (ComparePage) renders the exact same
 * TradingViewCompareChart for any two tokens picked directly, not just
 * ones that came out of a Trend Finder search. */
export function TrendPeerTable({
  peers,
  seedId,
  seedSymbol,
  confirmedIds,
  reasons,
  watchlists,
}: {
  peers: PeerRow[];
  seedId?: string;
  seedSymbol: string;
  confirmedIds?: Set<string>;
  reasons?: Map<string, string>;
  /** `null` = not signed in, `[]` = signed in with no watchlists yet — see
   * WatchlistAddMenu's own doc comment for what each renders. */
  watchlists: WatchlistSummary[] | null;
}) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSort(key: PeerSortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  const sorted = [...peers].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  const allSelected = peers.length > 0 && peers.every((p) => selected.has(p.id));
  const selectedCoins = peers.filter((p) => selected.has(p.id)).map(peerToCoin);

  return (
    <>
      {selected.size > 0 && (
        <div className="mb-2 flex items-center justify-end gap-2 text-sm">
          <span className="text-fg-muted">{selected.size} selected</span>
          <WatchlistAddMenu
            coins={selectedCoins}
            watchlists={watchlists}
            onAdded={() => setSelected(new Set())}
            trigger={
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-fg transition hover:bg-border">
                <ListPlus className="size-3.5" aria-hidden="true" />
                Add to watchlist
              </span>
            }
          />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(peers.map((p) => p.id)))}
                  aria-label={allSelected ? "Deselect all" : "Select all"}
                  className="size-3.5 rounded border-border"
                />
              </th>
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
            const reason = reasons?.get(peer.id);
            const isExpanded = expanded.has(peer.id);
            return (
              <Fragment key={peer.id}>
                <tr className={`${trClass} ${isSeed ? "bg-accent/10" : ""}`}>
                  <td className={tdClass}>
                    <input
                      type="checkbox"
                      checked={selected.has(peer.id)}
                      onChange={() => toggleSelected(peer.id)}
                      aria-label={`Select ${peer.symbol}`}
                      className="size-3.5 rounded border-border"
                    />
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      {!isSeed ? (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(peer.id)}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? `Hide chart for ${peer.symbol}` : `Compare ${peer.symbol} against ${seedSymbol}`}
                          className="text-fg-muted transition hover:text-fg"
                        >
                          {isExpanded ? (
                            <ChevronDown className="size-3.5" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="size-3.5" aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        <span className="size-3.5" aria-hidden="true" />
                      )}
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
                    <div className="flex items-center gap-2">
                      <WatchlistAddMenu
                        coins={[peerToCoin(peer)]}
                        watchlists={watchlists}
                        trigger={<ListPlus className="size-3.5" aria-hidden="true" />}
                        triggerClassName="text-fg-muted transition hover:text-accent"
                        triggerLabel={`Add ${peer.symbol} to watchlist`}
                      />
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
                      <Link
                        href={`/encyclopedia?id=${encodeURIComponent(peer.id)}`}
                        title="Open in Encyclopedia"
                        aria-label={`Open ${peer.symbol} in Encyclopedia`}
                        className="text-fg-muted transition hover:text-accent"
                      >
                        <BookOpen className="size-3.5" aria-hidden="true" />
                      </Link>
                    </div>
                  </td>
                </tr>
                {!isSeed && isExpanded && (
                  <tr className="border-b border-border bg-surface-raised/50">
                    <td colSpan={8} className="p-3">
                      {reason && (
                        <p className="mb-3 text-xs text-fg-muted">
                          <span className="font-medium text-fg">Why {peer.symbol}:</span> {stripCitations(reason)}
                        </p>
                      )}
                      <TradingViewCompareChart baseTicker={seedSymbol} compareTicker={peer.symbol} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          </tbody>
        </table>
      </div>
    </>
  );
}

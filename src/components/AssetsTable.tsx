"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ArrowUp, ArrowDown, ChevronsUpDown, ChevronRight, ChevronDown, Search } from "lucide-react";
import type { AssetGroup } from "@/lib/queries";
import { formatUsd, formatQty } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { inputClass } from "./ui/Field";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "./ui/table";

type SortKey = "ticker" | "qty" | "wallets" | "value";

function sortValue(group: AssetGroup, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return group.ticker.toLowerCase();
    case "qty":
      return group.totalQty ?? -Infinity;
    case "wallets":
      return group.holdings.length;
    case "value":
      return group.total;
  }
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
}: {
  label: string;
  sortKeyValue: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  return (
    <th className={thClass}>
      <button type="button" onClick={() => onSort(sortKeyValue)} className="flex items-center gap-1 hover:text-fg">
        {label}
        <SortIcon active={sortKey === sortKeyValue} dir={sortDir} />
      </button>
    </th>
  );
}

/**
 * One flat, searchable, sortable table — one row per asset — instead of a
 * stack of always-open sections, which doesn't hold up once someone has
 * 100+ distinct tokens (per feedback). Search and sort are both client-side
 * (all groups are already loaded — the hide-unpriced/hide-low filtering
 * above this component is what actually limits how much data reaches it,
 * that part stays server-driven via searchParams like the rest of the
 * app). Clicking a row expands it in place to show which wallets/chains
 * contribute to that total, instead of navigating away.
 */
export function AssetsTable({ groups }: { groups: AssetGroup[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function toggleExpand(tickerKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tickerKey)) next.delete(tickerKey);
      else next.add(tickerKey);
      return next;
    });
  }

  const query = search.trim().toLowerCase();
  const filtered = query ? groups.filter((g) => g.ticker.toLowerCase().includes(query)) : groups;

  const sorted = [...filtered].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="relative max-w-sm p-4 pb-3">
        <Search
          className="pointer-events-none absolute left-7 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search assets…"
          className={`${inputClass} pl-9`}
        />
      </div>

      {sorted.length === 0 ? (
        <p className="p-5 pt-0 text-center text-sm text-fg-muted">
          No assets match &ldquo;{search}&rdquo;.
        </p>
      ) : (
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}></th>
              <Header label="Asset" sortKeyValue="ticker" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Header label="Qty" sortKeyValue="qty" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Header label="Wallets" sortKeyValue="wallets" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Header label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((group) => {
              const isOpen = expanded.has(group.tickerKey);
              return (
                <Fragment key={group.tickerKey}>
                  <tr
                    className={`${trClass} cursor-pointer`}
                    onClick={() => toggleExpand(group.tickerKey)}
                    aria-expanded={isOpen}
                  >
                    <td className={tdClass}>
                      {isOpen ? (
                        <ChevronDown className="size-4 text-fg-muted" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-4 text-fg-muted" aria-hidden="true" />
                      )}
                    </td>
                    <td className={tdClass}>
                      <div className="flex items-center gap-2">
                        <TokenIcon ticker={group.ticker} url={group.iconUrl} />
                        <span className="font-medium text-fg">{group.ticker}</span>
                      </div>
                    </td>
                    <td className={`${tdClass} tabular-nums`}>
                      {group.totalQty !== null ? formatQty(group.totalQty) : "—"}
                    </td>
                    <td className={`${tdClass} text-fg-muted`}>{group.holdings.length}</td>
                    <td className={`${tdClass} tabular-nums`}>{formatUsd(group.total)}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} className="border-b border-border bg-bg p-0">
                        <table className={tableClass}>
                          <thead>
                            <tr className={theadRowClass}>
                              <th className={thClass}>Wallet</th>
                              <th className={thClass}>Chain</th>
                              <th className={thClass}>Qty</th>
                              <th className={thClass}>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.holdings.map((holding) => (
                              <tr key={holding.id} className={trClass}>
                                <td className={tdClass}>
                                  <Link
                                    href={`/wallets/${holding.walletId}`}
                                    className="text-fg hover:text-accent"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {holding.walletName}
                                  </Link>
                                </td>
                                <td className={tdClass}>
                                  <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                                    {holding.chainName}
                                  </span>
                                </td>
                                <td className={`${tdClass} tabular-nums`}>{formatQty(holding.qty)}</td>
                                <td className={`${tdClass} tabular-nums`}>
                                  {holding.valuation.kind === "priced" ? (
                                    formatUsd(holding.valuation.usd)
                                  ) : (
                                    <span className="text-warning">unpriced</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

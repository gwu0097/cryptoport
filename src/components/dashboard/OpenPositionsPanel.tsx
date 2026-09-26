"use client";

import Link from "next/link";
import type { OpenPosition } from "@/lib/queries";
import { formatPercent, formatPrice, formatQty, formatUsd, formatUsdSigned } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "position" | "margin" | "pnl";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:openPositionsSort";
const DEFAULT_SORT: Sort = { key: "margin", dir: "desc" };

function sortValue(p: OpenPosition, key: SortKey): number | string {
  switch (key) {
    case "position":
      return p.ticker;
    case "margin":
      return p.marginUsd ?? -Infinity;
    case "pnl":
      return p.pnlUsd ?? -Infinity;
  }
}

const tone = (n: number | null) => (n === null ? "text-fg-muted" : n > 0 ? "text-positive" : n < 0 ? "text-negative" : "text-fg");

/**
 * Every open perp position across the user's wallets, so an open position is
 * never out of sight. Reads what the wallet syncs stored; PnL is live as of
 * the last Refresh prices (the venue's mark price, perpPositions.ts) when that
 * is newer than the sync. Margin is already in each wallet's total — nothing
 * here adds to the Dashboard total.
 */
export function OpenPositionsPanel({ positions, asOfLabel }: { positions: OpenPosition[]; asOfLabel: string }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;
  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  const sorted = [...positions].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  const known = positions.filter((p) => p.pnlUsd !== null);
  const total = known.reduce((s, p) => s + (p.pnlUsd as number), 0);
  const unknown = positions.length - known.length;

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">
          Open positions <span className="font-normal text-fg-muted">({positions.length})</span>
        </h2>
        <p className="text-sm">
          <span className="text-fg-muted">Unrealized PnL </span>
          <span className={`font-semibold tabular-nums ${tone(known.length ? total : null)}`}>{known.length ? formatUsdSigned(total) : "—"}</span>
          {unknown > 0 && <span className="text-xs text-warning"> ({unknown} without PnL)</span>}
        </p>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{asOfLabel} Margin is already counted in each wallet&apos;s value.</p>
      <div className="mt-4 overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <SortableHeader label="Position" sortKeyValue="position" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th className={`${thClass} ${hideOnMobileClass}`}>Size</th>
              <th className={`${thClass} ${hideOnMobileClass}`}>Entry → Mark</th>
              <th className={`${thClass} ${hideOnMobileClass}`}>Liq. price</th>
              <SortableHeader label="Margin" sortKeyValue="margin" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="PnL" sortKeyValue="pnl" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={`${p.walletId}|${p.ticker}|${p.side}`} className={trClass}>
                <td className={tdClass}>
                  <span className="font-medium text-fg">{p.ticker}</span>{" "}
                  <span className={p.side === "long" ? "text-positive" : "text-negative"}>
                    {p.side === "long" ? "Long" : "Short"}
                    {p.leverage !== null && ` ${p.leverage}x`}
                  </span>
                  <div className="text-xs text-fg-muted">
                    {p.venue ?? "—"} ·{" "}
                    <Link href={`/wallets/${p.walletId}`} className="hover:text-fg hover:underline">
                      {p.walletName}
                    </Link>
                  </div>
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{p.size === null ? "—" : formatQty(p.size)}</td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                  {p.entryPrice === null ? "—" : formatPrice(p.entryPrice)} → {p.markPrice === null ? "—" : formatPrice(p.markPrice)}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{p.liquidationPrice === null ? "—" : formatPrice(p.liquidationPrice)}</td>
                <td className={`${tdClass} tabular-nums`}>{p.marginUsd === null ? "—" : formatUsd(p.marginUsd)}</td>
                <td className={`${tdClass} tabular-nums ${tone(p.pnlUsd)}`}>
                  {p.pnlUsd === null ? "—" : formatUsdSigned(p.pnlUsd)}
                  {p.pnlPercent !== null && <span className="ml-1 text-xs">({formatPercent(p.pnlPercent)})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

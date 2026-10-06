"use client";

import { useMemo } from "react";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { usePersistedState } from "@/components/usePersistedState";
import { formatCompactUsd } from "@/lib/format";
import type { ScoutBook, ScoutTrader } from "@/lib/perpScoutScan";
import { compareNullable, explorerUrl, shortAddress, signedPct, sharePct, toneOf } from "./labels";

type SortKey = "rank" | "trader" | "equity" | "allTime" | "month" | "week" | "roi" | "history" | "winWeeks" | "drawdown" | "best4" | "leverage" | "bias" | "positions";

interface Row {
  t: ScoutTrader;
  rank: number;
  book: ScoutBook | null;
}

function sortValue(r: Row, key: SortKey): number | string | null {
  switch (key) {
    case "rank": return r.rank;
    case "trader": return (r.t.displayName ?? r.t.address).toLowerCase();
    case "equity": return r.book?.accountValue ?? r.t.accountValue;
    case "allTime": return r.t.allTimePnl;
    case "month": return r.t.monthPnl;
    case "week": return r.t.weekPnl;
    case "roi": return r.t.allTimeRoi;
    case "history": return r.t.stats.historyWeeks;
    case "winWeeks": return r.t.stats.winningWeeksShare;
    case "drawdown": return r.t.stats.drawdownShare;
    case "best4": return r.t.stats.bestFourShare;
    case "leverage": return r.book?.leverage ?? null;
    case "bias": return r.book?.bias ?? null;
    case "positions": return r.book?.positions ?? null;
  }
}

function biasLabel(bias: number | null): string {
  if (bias === null) return "—";
  if (bias > 0.5) return "Long";
  if (bias < -0.5) return "Short";
  return "Hedged";
}

/** The followed traders, ranked by the screen's score (return ÷ drawdown). */
export function TradersTable({ traders, books }: { traders: ScoutTrader[]; books: ScoutBook[] }) {
  const [sortKey, setSortKey] = usePersistedState<SortKey>("cryptoport:perpScoutTradersSort", "rank");
  const [sortDir, setSortDir] = usePersistedState<"asc" | "desc">("cryptoport:perpScoutTradersSortDir", "asc");
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir(key === "rank" ? "asc" : "desc");
    }
  };
  const rows = useMemo(() => {
    const byAddress = new Map(books.map((b) => [b.address, b]));
    return traders
      .map((t, i): Row => ({ t, rank: i + 1, book: byAddress.get(t.address) ?? null }))
      .sort((a, b) => compareNullable(sortValue(a, sortKey), sortValue(b, sortKey), sortDir));
  }, [traders, books, sortKey, sortDir]);
  const h = (label: string, key: SortKey, className = "") => <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />;

  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr className={`${theadRowClass} whitespace-nowrap`}>
            {h("#", "rank")}
            {h("Trader", "trader")}
            {h("Equity", "equity")}
            {h("All-time PnL", "allTime")}
            {h("30d", "month")}
            {h("7d", "week", hideOnMobileClass)}
            {h("ROI", "roi", hideOnMobileClass)}
            {h("History", "history", hideOnMobileClass)}
            {h("Win weeks", "winWeeks", hideOnMobileClass)}
            {h("Max DD", "drawdown", hideOnMobileClass)}
            {h("Best 4 wks", "best4", hideOnMobileClass)}
            {h("Leverage", "leverage", hideOnMobileClass)}
            {h("Book", "bias", hideOnMobileClass)}
            {h("Open", "positions")}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, rank, book }) => (
            <tr key={t.address} className={trClass}>
              <td className={`${tdClass} text-fg-muted`}>{rank}</td>
              <td className={tdClass}>
                <a href={explorerUrl(t.address)} target="_blank" rel="noreferrer" className="whitespace-nowrap hover:text-accent" title={t.address}>
                  {t.displayName ?? shortAddress(t.address)}
                </a>
                {book?.error && (
                  <span className="ml-1.5 text-xs text-warning" title={book.error}>
                    not read
                  </span>
                )}
              </td>
              <td className={tdClass}>{formatCompactUsd(book?.accountValue ?? t.accountValue)}</td>
              <td className={`${tdClass} ${toneOf(t.allTimePnl)}`}>{formatCompactUsd(t.allTimePnl)}</td>
              <td className={`${tdClass} ${toneOf(t.monthPnl)}`}>{formatCompactUsd(t.monthPnl)}</td>
              <td className={`${tdClass} ${hideOnMobileClass} ${toneOf(t.weekPnl)}`}>{formatCompactUsd(t.weekPnl)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{signedPct(t.allTimeRoi, 0)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{Math.round(t.stats.historyWeeks / 4.35)} mo</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{sharePct(t.stats.winningWeeksShare)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Largest fall of the PnL curve ÷ typical equity">{sharePct(t.stats.drawdownShare)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Share of all profit made in the best 4 weeks">{sharePct(t.stats.bestFourShare)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Total position size ÷ account value">{book?.leverage == null ? "—" : `${book.leverage.toFixed(1)}×`}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{biasLabel(book?.bias ?? null)}</td>
              <td className={tdClass}>{book ? book.positions : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

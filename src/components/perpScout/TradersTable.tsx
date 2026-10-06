"use client";

import { useMemo } from "react";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { usePersistedState } from "@/components/usePersistedState";
import { formatCompactUsd } from "@/lib/format";
import type { ScoutBook } from "@/lib/perpScoutScan";
import type { FollowedTrader } from "@/lib/perpScout/followed";
import { compareNullable, explorerUrl, hyperdashUrl, sharePct, toneOf } from "./labels";

type SortKey = "name" | "equity" | "allTime" | "month" | "history" | "winWeeks" | "drawdown" | "best4" | "leverage" | "bias" | "positions" | "added";

interface Row {
  f: FollowedTrader;
  book: ScoutBook | null;
  /** The record: the last scan's when it read one, else the figures it was
   * picked on (`live` false). */
  fig: { live: boolean; equity: number | null; allTimePnl: number | null; monthPnl: number | null; historyMonths: number | null; winningWeeks: number | null; drawdownShare: number | null; bestFourShare: number | null };
}

function figures(f: FollowedTrader, book: ScoutBook | null): Row["fig"] {
  const s = book?.stats;
  if (!s) return { live: false, ...f.picked, equity: book?.accountValue ?? f.picked.equity };
  return {
    live: true,
    equity: book?.accountValue ?? s.equityNow,
    allTimePnl: s.totalPnl,
    monthPnl: s.monthPnl,
    historyMonths: Math.round(s.historyWeeks / 4.35),
    winningWeeks: s.winningWeeksShare,
    drawdownShare: s.drawdownShare,
    bestFourShare: s.bestFourShare,
  };
}

function sortValue(r: Row, key: SortKey): number | string | null {
  const p = r.fig;
  switch (key) {
    case "name": return r.f.name.toLowerCase();
    case "equity": return p.equity;
    case "allTime": return p.allTimePnl;
    case "month": return p.monthPnl;
    case "history": return p.historyMonths;
    case "winWeeks": return p.winningWeeks;
    case "drawdown": return p.drawdownShare;
    case "best4": return p.bestFourShare;
    case "leverage": return r.book?.leverage ?? null;
    case "bias": return r.book?.bias ?? null;
    case "positions": return r.book?.positions ?? null;
    case "added": return r.f.addedOn;
  }
}

function biasLabel(bias: number | null): string {
  if (bias === null) return "—";
  if (bias > 0.5) return "Long";
  if (bias < -0.5) return "Short";
  return "Hedged";
}

/** The followed traders (followed.ts): their perps record and book as of the
 * last scan (else the figures they were picked on), leverage, bias, open
 * positions. */
export function TradersTable({ followed, books }: { followed: readonly FollowedTrader[]; books: ScoutBook[] }) {
  const [sortKey, setSortKey] = usePersistedState<SortKey>("cryptoport:perpScoutTradersSort", "allTime");
  const [sortDir, setSortDir] = usePersistedState<"asc" | "desc">("cryptoport:perpScoutTradersSortDir", "desc");
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };
  const rows = useMemo(() => {
    const byAddress = new Map(books.map((b) => [b.address, b]));
    return followed
      .map((f): Row => {
        const book = byAddress.get(f.address) ?? null;
        return { f, book, fig: figures(f, book) };
      }).sort((a, b) => compareNullable(sortValue(a, sortKey), sortValue(b, sortKey), sortDir));
  }, [followed, books, sortKey, sortDir]);
  const h = (label: string, key: SortKey, className = "") => <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />;

  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr className={`${theadRowClass} whitespace-nowrap`}>
            {h("Trader", "name")}
            {h("Equity", "equity")}
            {h("All-time PnL", "allTime")}
            {h("30d", "month", hideOnMobileClass)}
            {h("History", "history", hideOnMobileClass)}
            {h("Win weeks", "winWeeks", hideOnMobileClass)}
            {h("Max DD", "drawdown", hideOnMobileClass)}
            {h("Best 4 wks", "best4", hideOnMobileClass)}
            {h("Leverage", "leverage", hideOnMobileClass)}
            {h("Book", "bias", hideOnMobileClass)}
            {h("Open", "positions")}
            {h("Added", "added", hideOnMobileClass)}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ f, book, fig }) => (
            <tr key={f.address} className={trClass}>
              <td className={tdClass} title={f.why}>
                <a href={explorerUrl(f.address)} target="_blank" rel="noreferrer" className="whitespace-nowrap hover:text-accent" title="Hyperliquid explorer">
                  {f.name}
                </a>
                <a href={hyperdashUrl(f.address)} target="_blank" rel="noreferrer" className="ml-2 rounded border border-border px-1.5 py-0.5 text-xs text-fg-muted hover:border-accent hover:text-accent">
                  HyperDash ↗
                </a>
                {book?.error && (
                  <span className="ml-1.5 text-xs text-warning" title={book.error}>
                    not read
                  </span>
                )}
                <div className="max-w-xs truncate text-xs text-fg-muted">{f.why}</div>
              </td>
              <td className={tdClass} title={fig.live ? "Whole account (perps + spot), last scan" : `When picked (${f.picked.asOf})`}>{formatCompactUsd(fig.equity)}</td>
              <td className={`${tdClass} ${toneOf(fig.allTimePnl)}`} title={fig.live ? "Perps PnL, all time" : `When picked (${f.picked.asOf})`}>{formatCompactUsd(fig.allTimePnl)}</td>
              <td className={`${tdClass} ${hideOnMobileClass} ${toneOf(fig.monthPnl)}`}>{formatCompactUsd(fig.monthPnl)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{fig.historyMonths === null ? "—" : `${fig.historyMonths} mo`}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{sharePct(fig.winningWeeks)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Largest fall of the perps PnL curve ÷ the account's typical value">{sharePct(fig.drawdownShare)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Share of all perps profit made in the best 4 weeks">{sharePct(fig.bestFourShare)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Total position size ÷ account value">{book?.leverage == null ? "—" : `${book.leverage.toFixed(1)}×`}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{biasLabel(book?.bias ?? null)}</td>
              <td className={tdClass}>{book ? book.positions : "—"}</td>
              <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap text-fg-muted`}>{f.addedOn}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

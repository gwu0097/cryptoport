"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { usePersistedState } from "@/components/usePersistedState";
import { formatCompactUsd } from "@/lib/format";
import type { ScoutBook } from "@/lib/perpScoutScan";
import type { FollowedTrader } from "@/lib/perpScout/followed";
import { compareNullable, explorerUrl, hyperdashUrl, sharePct, signedPct, toneOf } from "./labels";
import { ConfirmActionButton } from "@/components/ui/ConfirmActionButton";

type SortKey = "name" | "equity" | "allTime" | "month" | "history" | "winWeeks" | "drawdown" | "best4" | "leverage" | "bias" | "positions" | "added";

interface Row {
  f: FollowedTrader;
  book: ScoutBook | null;
  /** The record: the last scan's when it read one, else the figures it was
   * picked on (`live` false). */
  fig: { live: boolean; equity: number | null; allTimePnl: number | null; monthPnl: number | null; historyMonths: number | null; winningWeeks: number | null; drawdownShare: number | null; bestFourShare: number | null; allTimePct: number | null; monthPct: number | null };
}

const ratio = (pnl: number | null, base: number | null | undefined) => (pnl !== null && base != null && base > 0 ? pnl / base : null);

/** All-time % is perps profit ÷ the account's typical (median) value — the
 * money it usually trades with, so deposits and withdrawals don't move it;
 * 30-day % is the month's perps profit ÷ the account now. */
function figures(f: FollowedTrader, book: ScoutBook | null): Row["fig"] {
  const s = book?.stats;
  if (!s) {
    const p = f.picked;
    const equity = book?.accountValue ?? p.equity;
    return { live: false, ...p, equity, allTimePct: ratio(p.allTimePnl, p.typicalEquity ?? p.equity), monthPct: ratio(p.monthPnl, p.equity) };
  }
  const equity = book?.accountValue ?? s.equityNow;
  return {
    live: true,
    equity,
    allTimePnl: s.totalPnl,
    monthPnl: s.monthPnl,
    historyMonths: Math.round(s.historyWeeks / 4.35),
    winningWeeks: s.winningWeeksShare,
    drawdownShare: s.drawdownShare,
    bestFourShare: s.bestFourShare,
    allTimePct: ratio(s.totalPnl, s.typicalEquity),
    monthPct: ratio(s.monthPnl, equity),
  };
}

function sortValue(r: Row, key: SortKey): number | string | null {
  const p = r.fig;
  switch (key) {
    case "name": return r.f.name.toLowerCase();
    case "equity": return p.equity;
    case "allTime": return p.allTimePct ?? p.allTimePnl;
    case "month": return p.monthPct ?? p.monthPnl;
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
export function TradersTable({ followed, books, removable = [] }: { followed: readonly FollowedTrader[]; books: ScoutBook[]; removable?: readonly string[] }) {
  const router = useRouter();
  const [removeError, setRemoveError] = useState<string | null>(null);
  async function remove(address: string) {
    setRemoveError(null);
    const res = await fetch("/api/perp-scout/traders", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) setRemoveError(body.error ?? `HTTP ${res.status}`);
    else router.refresh();
  }
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
            {h("All-time %", "allTime")}
            {h("30d %", "month", hideOnMobileClass)}
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
              <td className={`${tdClass} whitespace-nowrap`} title={`Perps PnL, all time, as a % of the account's typical value${fig.live ? "" : ` (when picked, ${f.picked.asOf})`}`}>
                <span className={`font-medium ${toneOf(fig.allTimePct ?? fig.allTimePnl)}`}>{signedPct(fig.allTimePct, 0)}</span>
                <span className="ml-1.5 text-xs text-fg-muted">{formatCompactUsd(fig.allTimePnl)}</span>
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap`} title="Perps PnL over the last 30 days, as a % of the account now">
                <span className={`font-medium ${toneOf(fig.monthPct ?? fig.monthPnl)}`}>{signedPct(fig.monthPct)}</span>
                <span className="ml-1.5 text-xs text-fg-muted">{formatCompactUsd(fig.monthPnl)}</span>
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{fig.historyMonths === null ? "—" : `${fig.historyMonths} mo`}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{sharePct(fig.winningWeeks)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Largest fall of the perps PnL curve ÷ the account's typical value">{sharePct(fig.drawdownShare)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Share of all perps profit made in the best 4 weeks">{sharePct(fig.bestFourShare)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title="Total position size ÷ account value">{book?.leverage == null ? "—" : `${book.leverage.toFixed(1)}×`}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{biasLabel(book?.bias ?? null)}</td>
              <td className={tdClass}>{book ? book.positions : "—"}</td>
              <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap text-fg-muted`}>
                {f.addedOn}
                {removable.includes(f.address) && (
                  <span className="ml-2">
                    <ConfirmActionButton
                      message={`Remove ${f.name}?`}
                      confirmLabel="Remove"
                      onConfirm={() => remove(f.address)}
                      trigger={(open) => (
                        <button type="button" onClick={open} className="align-middle text-fg-muted hover:text-negative" aria-label={`Remove ${f.name}`} title="Remove from the list">
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {removeError && <p className="mt-2 text-xs text-warning">{removeError}</p>}
    </div>
  );
}

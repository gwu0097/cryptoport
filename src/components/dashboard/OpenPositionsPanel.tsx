"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { OpenPosition } from "@/lib/queries";
import { refreshOpenPositions } from "@/app/(app)/dashboard/actions";
import { formatPercent, formatPrice, formatQty, formatUsd, formatUsdSigned } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Button } from "@/components/ui/Button";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "position" | "value" | "pnl";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:openPositionsSort";
const COLLAPSED_KEY = "cryptoport:openPositionsCollapsed";
const DEFAULT_SORT: Sort = { key: "value", dir: "desc" };

function sortValue(p: OpenPosition, key: SortKey): number | string {
  switch (key) {
    case "position":
      return p.label ?? p.ticker;
    case "value":
      return p.valueUsd ?? -Infinity;
    case "pnl":
      return p.pnlUsd ?? -Infinity;
  }
}

const tone = (n: number | null) => (n === null ? "text-fg-muted" : n > 0 ? "text-positive" : n < 0 ? "text-negative" : "text-fg");
const price = (n: number | null) => (n === null ? "—" : formatPrice(n));

/** Re-reads the venue accounts that have an open position (dashboard/actions.ts). */
function RefreshPositionsButton() {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        title="Re-reads only the exchange accounts with an open position (one call each) — no chain scan, no price refresh."
        onClick={() =>
          start(async () => {
            try {
              const r = await refreshOpenPositions();
              setNote(r.failed.length ? `Couldn't refresh ${r.failed.join("; ")} — shown as last synced.` : null);
            } catch (e) {
              setNote(`Refresh failed: ${(e as Error).message}`);
            }
          })
        }
      >
        <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden="true" />
        {pending ? "Refreshing positions…" : "Refresh positions"}
      </Button>
      {note && <p className="max-w-xs text-right text-xs text-warning">{note}</p>}
    </div>
  );
}

/**
 * Every open position across the user's wallets — perps (Hyperliquid, Lighter,
 * Jupiter) and prediction-market positions (Polymarket) — so none is out of
 * sight. Reads what the syncs stored. "Refresh positions" re-reads just those
 * venue accounts; Refresh prices updates perp PnL from the venue's mark
 * (perpPositions.ts). Values are already in each wallet's total; nothing here
 * adds to the Dashboard total.
 */
export function OpenPositionsPanel({ positions, asOfLabel }: { positions: OpenPosition[]; asOfLabel: string }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const [collapsed, setCollapsed] = usePersistedState<boolean>(COLLAPSED_KEY, false);
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
  // Margin locked in perps, and what prediction positions are worth — the
  // two kinds of money at risk here (a prediction has no margin).
  const perps = positions.filter((p) => p.kind === "perp");
  const margin = perps.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  const predictions = positions.filter((p) => p.kind === "prediction");
  const predictionValue = predictions.reduce((s, p) => s + (p.valueUsd ?? 0), 0);

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* The header toggles the table; the totals stay visible collapsed. */}
        <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} className="text-left">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-fg">
            <ChevronRight className={`size-4 text-fg-muted transition-transform ${collapsed ? "" : "rotate-90"}`} aria-hidden="true" />
            Open positions <span className="font-normal text-fg-muted">({positions.length})</span>
          </h2>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-5.5 text-sm">
            <span>
              <span className="text-fg-muted">Unrealized PnL </span>
              <span className={`font-semibold tabular-nums ${tone(known.length ? total : null)}`}>{known.length ? formatUsdSigned(total) : "—"}</span>
              {unknown > 0 && <span className="text-xs text-warning"> ({unknown} without PnL)</span>}
            </span>
            {perps.length > 0 && (
              <span>
                <span className="text-fg-muted">Total margin </span>
                <span className="font-semibold tabular-nums text-fg">{formatUsd(margin)}</span>
              </span>
            )}
            {predictions.length > 0 && (
              <span>
                <span className="text-fg-muted">In predictions </span>
                <span className="font-semibold tabular-nums text-fg">{formatUsd(predictionValue)}</span>
              </span>
            )}
          </p>
        </button>
        <RefreshPositionsButton />
      </div>
      {!collapsed && (
        <>
      <p className="mt-2 text-xs text-fg-muted">{asOfLabel} Values are already counted in each wallet&apos;s total (a perp at its margin).</p>
      <div className="mt-4 overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <SortableHeader label="Position" sortKeyValue="position" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th className={`${thClass} ${hideOnMobileClass}`}>Size</th>
              <th className={`${thClass} ${hideOnMobileClass}`}>Entry → Now</th>
              <th className={`${thClass} ${hideOnMobileClass}`}>Liq. price</th>
              <th className={`${thClass} ${hideOnMobileClass}`}>TP / SL</th>
              <SortableHeader label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="PnL" sortKeyValue="pnl" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={`${p.walletId}|${p.venue}|${p.label ?? p.ticker}|${p.side}`} className={trClass}>
                <td className={tdClass}>
                  {p.kind === "perp" ? (
                    <>
                      <span className="font-medium text-fg">{p.ticker}</span>{" "}
                      <span className={p.side === "long" ? "text-positive" : "text-negative"}>
                        {p.side === "long" ? "Long" : "Short"}
                        {p.leverage !== null && ` ${p.leverage}x`}
                      </span>
                    </>
                  ) : (
                    <span className="font-medium text-fg">{p.label ?? p.ticker}</span>
                  )}
                  <div className="text-xs text-fg-muted">
                    {p.venue ?? "—"} ·{" "}
                    <Link href={`/wallets/${p.walletId}`} className="hover:text-fg hover:underline">
                      {p.walletName}
                    </Link>
                  </div>
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                  {p.size === null ? "—" : formatQty(p.size)}
                  {p.kind === "prediction" && <span className="text-xs text-fg-muted"> shares</span>}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                  {price(p.entryPrice)} → {price(p.markPrice)}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                  {p.kind === "perp" && p.liquidationPrice === null ? (
                    // The venue publishes none (e.g. Hyperliquid for a cross
                    // position backed by the rest of the account) — not estimated here.
                    <span title="The venue reports no liquidation price for this position">—</span>
                  ) : (
                    price(p.liquidationPrice)
                  )}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                  {/* "—": the venue's orders aren't known (Lighter, a failed read, a prediction). */}
                  {p.tpsl === null ? (
                    "—"
                  ) : p.tpsl.tp === null && p.tpsl.sl === null ? (
                    <span className="text-xs text-fg-muted">None set</span>
                  ) : (
                    <span className="flex flex-col text-xs">
                      {p.tpsl.tp !== null && <span className="text-positive">TP {formatPrice(p.tpsl.tp)}</span>}
                      {p.tpsl.sl !== null && <span className="text-negative">SL {formatPrice(p.tpsl.sl)}</span>}
                      {p.tpsl.more > 0 && <span className="text-fg-muted">+{p.tpsl.more} more</span>}
                    </span>
                  )}
                </td>
                <td className={`${tdClass} tabular-nums`}>{p.valueUsd === null ? "—" : formatUsd(p.valueUsd)}</td>
                <td className={`${tdClass} tabular-nums ${tone(p.pnlUsd)}`}>
                  {p.pnlUsd === null ? "—" : formatUsdSigned(p.pnlUsd)}
                  {p.pnlPercent !== null && <span className="ml-1 text-xs">({formatPercent(p.pnlPercent)})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        </>
      )}
    </div>
  );
}

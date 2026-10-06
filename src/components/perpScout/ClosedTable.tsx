"use client";

import { useMemo } from "react";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { usePersistedState } from "@/components/usePersistedState";
import { useNowSec } from "@/components/useServerNow";
import { TokenIcon } from "@/components/TokenIcon";
import { formatPrice, formatUsdSigned } from "@/lib/format";
import type { ScoutClose } from "@/lib/perpScout/closes";
import { ago, compareNullable, explorerUrl, hyperdashUrl, shortAddress, signedPct, toneOf } from "./labels";

type SortKey = "trader" | "coin" | "side" | "closed" | "held" | "entry" | "exit" | "ret" | "pnl";

type Close = ScoutClose & { iconUrl?: string | null };

function heldText(ms: number | null): string {
  if (ms === null) return "—";
  const h = ms / 3_600_000;
  return h < 48 ? `${Math.max(1, Math.round(h))} h` : `${Math.round(h / 24)} d`;
}

/** Positions the followed traders closed in the last days, from their fills:
 * the whole exit (trims included), entry → exit, return and PnL. */
export function ClosedTable({ closes, names, serverNowSec }: { closes: readonly Close[]; names: Record<string, string>; serverNowSec: number }) {
  const nowMs = useNowSec(serverNowSec) * 1000;
  const [sortKey, setSortKey] = usePersistedState<SortKey>("cryptoport:perpScoutClosedSort", "closed");
  const [sortDir, setSortDir] = usePersistedState<"asc" | "desc">("cryptoport:perpScoutClosedSortDir", "desc");
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };
  const rows = useMemo(() => {
    const value = (c: Close, key: SortKey): number | string | null => {
      switch (key) {
        case "trader": return (names[c.address] ?? c.address).toLowerCase();
        case "coin": return c.coin.toLowerCase();
        case "side": return c.side;
        case "closed": return c.closedAt;
        case "held": return c.openedAt === null ? null : c.closedAt - c.openedAt;
        case "entry": return c.entryPx;
        case "exit": return c.exitPx;
        case "ret": return c.returnPct;
        case "pnl": return c.pnlUsd;
      }
    };
    return [...closes].sort((a, b) => compareNullable(value(a, sortKey), value(b, sortKey), sortDir));
  }, [closes, names, sortKey, sortDir]);
  const h = (label: string, key: SortKey, className = "") => <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />;

  if (closes.length === 0) return <p className="text-sm text-fg-muted">No positions closed in this window.</p>;
  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr className={`${theadRowClass} whitespace-nowrap`}>
            {h("Trader", "trader")}
            {h("Coin", "coin")}
            {h("Side", "side", hideOnMobileClass)}
            {h("Closed", "closed")}
            {h("Held", "held", hideOnMobileClass)}
            {h("Their entry", "entry", hideOnMobileClass)}
            {h("Exit", "exit", hideOnMobileClass)}
            {h("Return", "ret")}
            {h("PnL", "pnl", hideOnMobileClass)}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={`${c.address}:${c.coin}:${c.closedAt}`} className={trClass}>
              <td className={tdClass}>
                <a href={explorerUrl(c.address)} target="_blank" rel="noreferrer" className="whitespace-nowrap hover:text-accent" title={c.address}>
                  {names[c.address] ?? shortAddress(c.address)}
                </a>
                <a href={hyperdashUrl(c.address)} target="_blank" rel="noreferrer" className="ml-1.5 text-xs text-fg-muted hover:text-accent" title="Open on HyperDash">
                  ↗
                </a>
              </td>
              <td className={`${tdClass} whitespace-nowrap font-medium`}>
                <span className="inline-flex items-center gap-1.5 align-middle">
                  <TokenIcon ticker={c.coin} url={c.iconUrl ?? null} size="sm" />
                  {c.coin}
                </span>
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} ${c.side === "long" ? "text-positive" : "text-negative"}`}>{c.side === "long" ? "Long" : "Short"}</td>
              <td className={`${tdClass} whitespace-nowrap`} title={new Date(c.closedAt).toLocaleString()}>
                {ago(c.closedAt, nowMs)}
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`} title={c.openedAt === null ? "Opened before their latest 2,000 fills" : undefined}>
                {c.openedAt === null ? <span className="text-fg-muted">—</span> : heldText(c.closedAt - c.openedAt)}
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{c.entryPx === null ? "—" : formatPrice(c.entryPx)}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>{formatPrice(c.exitPx)}</td>
              <td className={`${tdClass} font-medium ${toneOf(c.returnPct)}`} title="The move from their entry to their exit, in their direction (at 1×)">
                {signedPct(c.returnPct)}
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} ${toneOf(c.pnlUsd)}`}>{c.pnlUsd === null ? "—" : formatUsdSigned(Math.round(c.pnlUsd))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

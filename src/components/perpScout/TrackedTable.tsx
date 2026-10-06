"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { usePersistedState } from "@/components/usePersistedState";
import { useNowSec } from "@/components/useServerNow";
import { TokenIcon } from "@/components/TokenIcon";
import { formatPrice, formatUsdSigned } from "@/lib/format";
import { resolveTracked, trackedKey, type TrackedTrade, type TrackedView } from "@/lib/perpScout/tracked";
import type { ScoutEntry } from "@/lib/perpScout/entries";
import type { ScoutClose } from "@/lib/perpScout/closes";
import { ago, compareNullable, explorerUrl, hyperdashUrl, shortAddress, signedPct, toneOf } from "./labels";

type SortKey = "trader" | "coin" | "status" | "tracked" | "entry" | "price" | "vsEntry" | "since" | "pnl";

const STATUS: Record<TrackedView["status"]["kind"], { label: string; badge: string; order: number }> = {
  open: { label: "Open", badge: "bg-positive/15 text-positive", order: 0 },
  target: { label: "Take-profit hit", badge: "bg-positive/15 text-positive", order: 1 },
  stopped: { label: "Stopped out", badge: "bg-negative/15 text-negative", order: 2 },
  closed: { label: "Closed", badge: "bg-border text-fg", order: 3 },
  gone: { label: "Not seen", badge: "bg-border text-fg-muted", order: 4 },
};
const MOVE: Record<string, string> = { new: "opened", add: "added", trim: "trimmed" };

const price = (x: number | null) => (x === null ? "—" : formatPrice(x));

/**
 * The user's tracked trades (perpScout/tracked.ts): each one's status now —
 * open (and its latest move), closed, stopped out, take-profit hit — its
 * entry, the price when marked and now, the move since their entry and since
 * it was marked, and PnL. Shared by Perp Scout (top of the page) and the
 * Dashboard (beside Open positions); `compact` drops the secondary columns.
 */
export function TrackedTable({
  tracked,
  entries,
  closes,
  names,
  mids = null,
  serverNowSec,
  canEdit,
  compact = false,
}: {
  tracked: readonly TrackedTrade[];
  entries: readonly ScoutEntry[];
  closes: readonly (ScoutClose & { iconUrl?: string | null })[];
  names: Record<string, string>;
  mids?: Record<string, number> | null;
  serverNowSec: number;
  canEdit: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const nowMs = useNowSec(serverNowSec) * 1000;
  const [sortKey, setSortKey] = usePersistedState<SortKey>("cryptoport:perpScoutTrackedSort", "tracked");
  const [sortDir, setSortDir] = usePersistedState<"asc" | "desc">("cryptoport:perpScoutTrackedSortDir", "desc");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const icons = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of [...entries, ...closes]) if (x.iconUrl) m.set(x.coin, x.iconUrl);
    return m;
  }, [entries, closes]);

  const rows = useMemo(() => {
    const value = (v: TrackedView, key: SortKey): number | string | null => {
      switch (key) {
        case "trader": return (names[v.trade.address] ?? v.trade.address).toLowerCase();
        case "coin": return v.trade.coin.toLowerCase();
        case "status": return STATUS[v.status.kind].order;
        case "tracked": return v.trade.trackedAt;
        case "entry": return v.entryPx;
        case "price": return v.price;
        case "vsEntry": return v.vsEntry;
        case "since": return v.sinceTracked;
        case "pnl": return v.gainPct;
      }
    };
    return tracked
      .filter((t) => !hidden.has(trackedKey(t)))
      .map((t) => resolveTracked(t, entries, closes, mids))
      .sort((a, b) => compareNullable(value(a, sortKey), value(b, sortKey), sortDir));
  }, [tracked, hidden, entries, closes, mids, names, sortKey, sortDir]);

  async function untrack(t: TrackedTrade) {
    const key = trackedKey(t);
    setHidden((prev) => new Set(prev).add(key));
    setError(null);
    const res = await fetch("/api/perp-scout/tracked", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    if (!res.ok) {
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    } else router.refresh();
  }

  const h = (label: string, key: SortKey, className = "") => <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />;
  const wide = compact ? "hidden" : hideOnMobileClass;

  if (rows.length === 0) return <p className="text-sm text-fg-muted">No tracked trades yet. Mark one with ☆ in Perp Scout&apos;s Activity table.</p>;
  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr className={`${theadRowClass} whitespace-nowrap`}>
            {h("Trader", "trader")}
            {h("Coin", "coin")}
            {h("Status", "status")}
            {h("Tracked", "tracked", hideOnMobileClass)}
            {h("Their entry", "entry", hideOnMobileClass)}
            {h("Now", "price")}
            {h("vs entry", "vsEntry", wide)}
            {h("Since tracked", "since")}
            {h("Their gain", "pnl")}
            <th className={`${tdClass} ${wide}`}>TP / SL</th>
            {canEdit && <th className={tdClass} aria-label="Untrack" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const t = v.trade;
            const st = STATUS[v.status.kind];
            const detail =
              v.status.kind === "open"
                ? v.status.move
                  ? ` · ${MOVE[v.status.move.kind]} ${ago(v.status.move.at, nowMs)}`
                  : ""
                : v.status.kind !== "gone"
                  ? ` ${ago(v.status.close.closedAt, nowMs)}`
                  : "";
            const open = v.status.kind === "open" ? v.status.entry : null;
            return (
              <tr key={trackedKey(t)} className={trClass}>
                <td className={tdClass}>
                  <a href={explorerUrl(t.address)} target="_blank" rel="noreferrer" className="whitespace-nowrap hover:text-accent" title={t.address}>
                    {names[t.address] ?? shortAddress(t.address)}
                  </a>
                  <a href={hyperdashUrl(t.address)} target="_blank" rel="noreferrer" className="ml-1.5 text-xs text-fg-muted hover:text-accent" title="Open on HyperDash">
                    ↗
                  </a>
                </td>
                <td className={`${tdClass} whitespace-nowrap font-medium`}>
                  <span className="inline-flex items-center gap-1.5 align-middle">
                    <TokenIcon ticker={t.coin} url={icons.get(t.coin) ?? null} size="sm" />
                    {t.coin}
                  </span>
                  <span className={`ml-1.5 text-xs ${t.side === "long" ? "text-positive" : "text-negative"}`}>{t.side === "long" ? "Long" : "Short"}</span>
                </td>
                <td className={`${tdClass} whitespace-nowrap`} title={v.status.kind === "gone" ? "Not open now and no close seen in the last days: closed longer ago, or the trader wasn't read" : undefined}>
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${st.badge}`}>
                    {st.label}
                    {detail}
                  </span>
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap text-fg-muted`} title={t.at.price !== null ? `Price then: ${formatPrice(t.at.price)}` : undefined}>
                  {ago(t.trackedAt, nowMs)}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>{price(v.entryPx)}</td>
                <td className={`${tdClass} whitespace-nowrap`}>
                  {price(v.price)}
                  {v.status.kind !== "open" && v.status.kind !== "gone" && <span className="ml-1 text-xs text-fg-muted">exit</span>}
                </td>
                <td className={`${tdClass} ${wide} ${toneOf(v.vsEntry)}`}>{signedPct(v.vsEntry)}</td>
                <td className={`${tdClass} font-medium ${toneOf(v.sinceTracked)}`} title="The move since you tracked it, in their direction (at 1×)">
                  {signedPct(v.sinceTracked)}
                </td>
                <td
                  className={`${tdClass} whitespace-nowrap`}
                  title={`${v.gainAt1x ? "Their return at 1× (leverage unknown)" : "Their return on margin: the move × their leverage"}${v.pnlUsd === null ? "" : ` · their PnL ${formatUsdSigned(Math.round(v.pnlUsd))}`}`}
                >
                  <span className={`font-medium ${toneOf(v.gainPct)}`}>{signedPct(v.gainPct)}</span>
                  {v.gainAt1x && <span className="ml-1 text-xs text-fg-muted">1×</span>}
                </td>
                <td className={`${tdClass} ${wide} whitespace-nowrap text-xs`}>
                  {price(open?.tp ?? t.at.tp)} / {(open?.sl ?? t.at.sl) === null ? <span className="text-fg-muted">none</span> : price(open?.sl ?? t.at.sl)}
                </td>
                {canEdit && (
                  <td className={tdClass}>
                    <button type="button" onClick={() => untrack(t)} className="text-fg-muted hover:text-negative" aria-label={`Untrack ${t.coin}`} title="Untrack">
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="mt-2 text-xs text-warning">{error}</p>}
    </div>
  );
}

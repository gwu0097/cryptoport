"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { tableClass, theadRowClass, trClass, hideOnMobileClass } from "@/components/ui/table";

/** Tighter than ui/table's cells: fifteen columns fit a 1600px page
 * without scrolling (owner 2026-10-06: "stuff being cut off"). */
const tdClass = "px-2 py-2.5 text-sm";
import { chipClass } from "@/components/ui/chip";
import { usePersistedState } from "@/components/usePersistedState";
import { useNowSec } from "@/components/useServerNow";
import { formatCompactUsd, formatPrice, formatUsdSigned } from "@/lib/format";
import { latestMove, liveFigures, positionRole, type MoveKind, type PositionRole, type ScoutEntry } from "@/lib/perpScout/entries";
import type { ScoutBook } from "@/lib/perpScoutScan";
import { summarizeCloses, type CloseSummary, type ScoutClose } from "@/lib/perpScout/closes";
import { groupByCoin } from "@/lib/perpScout/groups";
import { TokenIcon } from "@/components/TokenIcon";
import { findTracked, trackClose, trackOpen, trackedKey, type TrackedTrade } from "@/lib/perpScout/tracked";
import { ago, compareNullable, explorerUrl, hyperdashUrl, shortAddress, signedPct, sharePct, toneOf } from "./labels";

type SortKey = "trader" | "trader30d" | "role" | "coin" | "side" | "move" | "opened" | "notional" | "share" | "leverage" | "entry" | "open" | "mark" | "vsEntry" | "vsOpen" | "pnl" | "tp" | "sl" | "liq";
type Window = "24h" | "7d" | "30d" | "any";
const WINDOW_MS: Record<Window, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, any: Infinity };

type Close = ScoutClose & { iconUrl?: string | null };
type Status = "all" | "open" | "closed";

interface OpenRow {
  kind: "open";
  e: ScoutEntry;
  name: string;
  live: ReturnType<typeof liveFigures>;
  role: { role: PositionRole; why: string };
  /** The trader's perps PnL over the last 30 days, and as a share of their account. */
  month: { usd: number | null; share: number | null };
}

/** A trader's closes of one coin on one side in the window, summed
 * (closes.ts `summarizeCloses`). */
interface ClosedRow {
  kind: "closed";
  c: Omit<CloseSummary, "closes"> & { closes: Close[] };
  name: string;
  month: { usd: number | null; share: number | null };
}

type Row = OpenRow | ClosedRow;

const coinOf = (r: Row) => (r.kind === "open" ? r.e.coin : r.c.coin);
const addressOf = (r: Row) => (r.kind === "open" ? r.e.address : r.c.address);
const sideOf = (r: Row) => (r.kind === "open" ? r.e.side : r.c.side);
const iconOf = (r: Row) => (r.kind === "open" ? r.e.iconUrl : r.c.closes.map((x) => x.iconUrl).find(Boolean)) ?? null;
/** A row's latest move: an open position's newest open/add/trim, a closed one's close. */
const moveOf = (r: Row): { kind: MoveKind | "close"; at: number } | null => (r.kind === "open" ? latestMove(r.e) : { kind: "close", at: r.c.lastClosedAt });

const ROLE_LABEL: Record<PositionRole, string> = { directional: "Directional", hedge: "Hedge", pair: "Paired", book: "Book leg" };
const ROLE_ORDER: Record<PositionRole, number> = { directional: 0, pair: 1, book: 2, hedge: 3 };
const ROLE_CLASS: Record<PositionRole, string> = { directional: "text-fg", pair: "text-fg-muted", book: "text-fg-muted", hedge: "text-warning" };

function sortValue(r: Row, key: SortKey): number | string | null {
  switch (key) {
    case "trader": return r.name.toLowerCase();
    case "trader30d": return r.month.usd;
    // Closed rows after every open role.
    case "role": return r.kind === "open" ? ROLE_ORDER[r.role.role] : 9;
    case "move": return moveOf(r)?.at ?? null;
    case "coin": return coinOf(r).toLowerCase();
    case "side": return sideOf(r);
    default:
      break;
  }
  if (r.kind === "closed") {
    const c = r.c;
    switch (key) {
      case "opened": return c.firstOpenedAt;
      case "notional": return c.size * c.exitPx;
      case "entry": return c.entryPx;
      case "mark": return c.exitPx;
      case "vsEntry": return c.returnPct;
      case "pnl": return c.returnPct;
      default: return null;
    }
  }
  const { e, live } = r;
  switch (key) {
    // Opened before the fills read sorts as just before that bound.
    case "opened": return e.openedAt ?? (e.openedBefore !== null ? e.openedBefore - 1 : null);
    case "notional": return live.notionalUsd;
    case "share": return e.equityShare;
    case "leverage": return e.leverage;
    case "entry": return e.entryPx;
    case "open": return e.openPx;
    case "mark": return live.mark;
    case "vsEntry": return live.vsEntry;
    case "vsOpen": return live.vsOpen;
    case "pnl": return live.roe;
    case "tp": return e.tp;
    case "sl": return e.sl;
    case "liq": return e.liquidationPx;
    default: return null;
  }
}

/** Columns in the table, for a group's header row. */
const COLUMNS = 13;

const MOVE_LABEL: Record<MoveKind | "close", string> = { new: "New", add: "Added", trim: "Trimmed", close: "Closed" };
const MOVE_BADGE: Record<MoveKind | "close", string> = { new: "bg-positive/15 text-positive", add: "bg-accent/15 text-accent", trim: "bg-warning/15 text-warning", close: "bg-border text-fg" };
/** A move this recent marks its row with its colour. */
const RECENT_MS = 24 * 60 * 60_000;
const MOVE_EDGE: Record<MoveKind | "close", string> = { new: "border-l-positive", add: "border-l-accent", trim: "border-l-warning", close: "border-l-fg-muted" };

/** A collapsed coin's activity: its latest move (a close included) and how
 * many of its rows moved in the last 24 h. */
function GroupActivity({ rows, nowMs }: { rows: readonly Row[]; nowMs: number }) {
  const moves = rows.map(moveOf).filter((m): m is NonNullable<typeof m> => m !== null);
  if (moves.length === 0) return null;
  const last = moves.reduce((a, b) => (b.at > a.at ? b : a));
  const recent = moves.filter((m) => nowMs - m.at <= RECENT_MS).length;
  return (
    <span className="ml-3 inline-flex items-center gap-2">
      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${MOVE_BADGE[last.kind]}`}>
        {MOVE_LABEL[last.kind]} {ago(last.at, nowMs)}
      </span>
      {recent > 0 && <span className="text-xs text-fg-muted">{recent} moved in 24h</span>}
    </span>
  );
}

const price = (x: number | null) => (x === null ? "—" : formatPrice(x));

/**
 * Perp Scout's Activity: every open position of the followed traders and
 * every position they closed in the last days, in one table (owner
 * 2026-10-06: "a holistic view grouped by tokens — under BTC 1 long, 1
 * short and 3 closes"). Prices are the scan's marks until Refresh prices
 * swaps in current mids (`mids`). "vs entry" is the move since their average
 * entry in their direction: negative means they're down and the price now is
 * better than theirs; on a closed row it's the return from entry to exit.
 */
export function EntriesTable({
  entries,
  closes,
  books,
  names,
  mids,
  serverNowSec,
  tracked = [],
  canTrack = false,
}: {
  entries: ScoutEntry[];
  closes: readonly Close[];
  books: ScoutBook[];
  names: Record<string, string>;
  mids: Record<string, number> | null;
  serverNowSec: number;
  /** The user's tracked trades: their rows show a filled ☆. */
  tracked?: readonly TrackedTrade[];
  canTrack?: boolean;
}) {
  const nowMs = useNowSec(serverNowSec) * 1000;
  const router = useRouter();
  // Marked or unmarked here, before the page re-renders with the saved list.
  const [optimistic, setOptimistic] = useState<{ add: TrackedTrade[]; drop: ReadonlySet<string> }>({ add: [], drop: new Set() });
  const [trackError, setTrackError] = useState<string | null>(null);
  const trackedNow = useMemo(() => [...tracked, ...optimistic.add].filter((t) => !optimistic.drop.has(trackedKey(t))), [tracked, optimistic]);

  async function toggleTrack(fresh: TrackedTrade) {
    const existing = findTracked(trackedNow, fresh);
    setTrackError(null);
    const res = existing
      ? (setOptimistic((o) => ({ add: o.add, drop: new Set(o.drop).add(trackedKey(existing)) })),
        await fetch("/api/perp-scout/tracked", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: trackedKey(existing) }) }))
      : (setOptimistic((o) => ({ add: [...o.add, fresh], drop: o.drop })),
        await fetch("/api/perp-scout/tracked", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trade: fresh }) }));
    if (!res.ok) setTrackError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    // The saved list replaces the optimistic one once the page re-renders.
    router.refresh();
    setOptimistic({ add: [], drop: new Set() });
  }

  const starCell = (fresh: TrackedTrade) => {
    const on = findTracked(trackedNow, fresh) !== undefined;
    return (
      <td className={`${tdClass} w-6 pr-0`}>
        <button
          type="button"
          disabled={!canTrack}
          onClick={() => toggleTrack(fresh)}
          className={`${on ? "text-warning" : "text-fg-muted hover:text-warning"} disabled:cursor-not-allowed disabled:opacity-40`}
          aria-pressed={on}
          aria-label={on ? `Untrack ${fresh.coin}` : `Track ${fresh.coin}`}
          title={canTrack ? (on ? "Tracked — click to untrack" : "Track this trade (Tracked trades, top of the page and the Dashboard)") : "Sign in to track trades"}
        >
          <Star className="size-3.5" fill={on ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      </td>
    );
  };
  const [sortKey, setSortKey] = usePersistedState<SortKey>("cryptoport:perpScoutEntriesSort", "opened");
  const [sortDir, setSortDir] = usePersistedState<"asc" | "desc">("cryptoport:perpScoutEntriesSortDir", "desc");
  const [window, setWindow] = usePersistedState<Window>("cryptoport:perpScoutWindow", "any");
  const [betterOnly, setBetterOnly] = usePersistedState("cryptoport:perpScoutBetterOnly", false);
  const [side, setSide] = usePersistedState<"both" | "long" | "short">("cryptoport:perpScoutSide", "both");
  const [trader, setTrader] = usePersistedState<string>("cryptoport:perpScoutTrader", "");
  const [directionalOnly, setDirectionalOnly] = usePersistedState("cryptoport:perpScoutDirectionalOnly", false);
  const [grouped, setGrouped] = usePersistedState("cryptoport:perpScoutGroupByCoin", false);
  const [status, setStatus] = usePersistedState<Status>("cryptoport:perpScoutStatus", "all");
  // Coins open in the grouped view: none at first, so many traders stay readable.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleCoin = (coin: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(coin)) next.delete(coin);
      else next.add(coin);
      return next;
    });

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const rows = useMemo(() => {
    const byTrader = new Map<string, ScoutEntry[]>();
    for (const e of entries) byTrader.set(e.address, [...(byTrader.get(e.address) ?? []), e]);
    const bookOf = new Map(books.map((b) => [b.address, b]));
    const monthOf = (address: string) => {
      const b = bookOf.get(address);
      const usd = b?.stats?.monthPnl ?? null;
      return { usd, share: usd !== null && b?.accountValue ? usd / b.accountValue : null };
    };
    const open: Row[] = entries.map((e) => ({
      kind: "open",
      e,
      name: names[e.address] ?? shortAddress(e.address),
      live: liveFigures(e, mids?.[e.coin]),
      role: positionRole(e, byTrader.get(e.address) ?? [e]),
      month: monthOf(e.address),
    }));
    // Closes in the window, then summed per trader, coin and side.
    const inWindow = closes.filter((c) => window === "any" || nowMs - c.closedAt <= WINDOW_MS[window]);
    const closed: Row[] = summarizeCloses(inWindow).map((c) => ({ kind: "closed", c, name: names[c.address] ?? shortAddress(c.address), month: monthOf(c.address) }));
    return [...(status === "closed" ? [] : open), ...(status === "open" ? [] : closed)]
      // A role is known only for open positions: closes stay in either way.
      .filter((r) => !directionalOnly || r.kind === "closed" || r.role.role === "directional")
      // Any move counts — opened, added to, trimmed or closed: a position
      // opened weeks ago that the trader added to yesterday is recent.
      .filter((r) => {
        if (window === "any") return true;
        const move = moveOf(r);
        return move !== null && nowMs - move.at <= WINDOW_MS[window];
      })
      // "Below their entry" is about entering now: closes don't apply.
      .filter((r) => !betterOnly || (r.kind === "open" && r.live.vsEntry !== null && r.live.vsEntry < 0))
      .filter((r) => side === "both" || sideOf(r) === side)
      .filter((r) => !trader || addressOf(r) === trader)
      .sort((a, b) => compareNullable(sortValue(a, sortKey), sortValue(b, sortKey), sortDir));
  }, [entries, closes, books, names, mids, window, betterOnly, side, trader, directionalOnly, status, sortKey, sortDir, nowMs]);

  const traders = useMemo(() => [...new Set([...entries.map((e) => e.address), ...closes.map((c) => c.address)])].sort((a, b) => (names[a] ?? a).localeCompare(names[b] ?? b)), [entries, closes, names]);
  const h = (label: string, key: SortKey, className = "") => <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />;

  const groups = useMemo(
    () =>
      groupByCoin(rows, (r) =>
        r.kind === "open"
          ? { coin: r.e.coin, address: r.e.address, side: r.e.side, notionalUsd: r.live.notionalUsd, entryPx: r.e.entryPx, size: r.e.size, directional: r.role.role === "directional" }
          : { coin: r.c.coin, address: r.c.address, side: r.c.side, notionalUsd: null, entryPx: null, size: 0, directional: false, closed: true, closes: r.c.count },
        // Coins follow the table's sort: each placed by its top row.
        "rows",
      ),
    [rows],
  );

  const renderRow = (r: Row) => (r.kind === "open" ? renderOpen(r) : renderClosed(r));

  const traderCells = (address: string, name: string, month: Row["month"]) => (
    <>
      <td className={tdClass}>
        <a href={explorerUrl(address)} target="_blank" rel="noreferrer" className="hover:text-accent" title={address}>
          {name}
        </a>
        <a href={hyperdashUrl(address)} target="_blank" rel="noreferrer" className="ml-1.5 text-xs text-fg-muted hover:text-accent" title="Open on HyperDash">
          ↗
        </a>
      </td>
      <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap ${toneOf(month.usd)}`} title="The trader's perps PnL over the last 30 days, and as a share of their account">
        {month.usd === null ? "—" : formatCompactUsd(month.usd)}
        {month.share !== null && <span className="ml-1 text-xs">{signedPct(month.share, 0)}</span>}
      </td>
    </>
  );

  const renderClosed = ({ c, name, month }: ClosedRow) => {
    const recent = nowMs - c.lastClosedAt <= RECENT_MS;
    const each = c.closes
      .map((x) => `${new Date(x.closedAt).toLocaleString()}: ${signedPct(x.returnPct)}${x.pnlUsd === null ? "" : `, ${formatUsdSigned(Math.round(x.pnlUsd))}`}`)
      .join("\n");
    const dash = <span className="text-fg-muted">—</span>;
    return (
      <tr key={`${c.address}:${c.coin}:${c.side}:closed`} className={`${trClass} border-l-2 ${recent ? MOVE_EDGE.close : "border-l-transparent"} bg-surface-raised/30`}>
        {starCell(trackClose(c.closes[0], nowMs))}
        {traderCells(c.address, name, month)}
        <td className={`${tdClass} whitespace-nowrap font-medium`}>
          <span className="inline-flex items-center gap-1.5 align-middle">
            <TokenIcon ticker={c.coin} url={c.closes.map((x) => x.iconUrl).find(Boolean) ?? null} size="sm" />
            {c.coin}
          </span>
          <span className={`ml-1.5 text-xs ${c.side === "long" ? "text-positive" : "text-negative"}`}>{c.side === "long" ? "Long" : "Short"}</span>
        </td>
        <td className={`${tdClass} whitespace-nowrap text-fg-muted`}>Closed</td>
        <td className={`${tdClass} whitespace-nowrap`}>
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${MOVE_BADGE.close}`} title={each}>
            {c.count > 1 ? `Closed ×${c.count} · ${ago(c.lastClosedAt, nowMs)}` : `Closed ${ago(c.lastClosedAt, nowMs)}`}
          </span>
        </td>
        <td className={`${tdClass} whitespace-nowrap`} title={c.firstOpenedAt === null ? "Opened before their latest fills" : c.count > 1 ? "The first of these opened" : undefined}>
          {c.firstOpenedAt !== null ? ago(c.firstOpenedAt, nowMs) : dash}
        </td>
        <td className={`${tdClass} ${hideOnMobileClass}`} title={c.count > 1 ? `Total closed over ${c.count} trades, at the exit price` : "Size closed, at the exit price"}>{formatCompactUsd(c.size * c.exitPx)}</td>
        <td className={tdClass}>{price(c.entryPx)}</td>
        <td className={tdClass} title="Their average exit">
          {formatPrice(c.exitPx)}
          <span className="block text-xs text-fg-muted">exit</span>
        </td>
        <td className={`${tdClass} font-medium ${toneOf(c.returnPct)}`} title={c.count > 1 ? `Combined return of the ${c.count} closes at 1× (total PnL ÷ the entry value closed):\n${each}` : "Return from their entry to their exit, in their direction (at 1×)"}>
          {signedPct(c.returnPct)}
        </td>
        <td className={`${tdClass} whitespace-nowrap`} title={c.count > 1 ? `Total realized PnL of ${c.count} closes, before fees` : "Realized PnL of the close, before fees"}>
          <span className={`text-xs ${toneOf(c.pnlUsd)}`}>{c.pnlUsd === null ? "—" : formatUsdSigned(Math.round(c.pnlUsd))}</span>
        </td>
        <td className={`${tdClass} ${hideOnMobileClass}`}>{dash}</td>
      </tr>
    );
  };

  const renderOpen = ({ e, name, live, role, month }: OpenRow) => {
    const move = latestMove(e);
    const recent = move !== null && nowMs - move.at <= RECENT_MS;
    return (
      <tr key={`${e.address}:${e.coin}`} className={`${trClass} border-l-2 ${recent ? MOVE_EDGE[move.kind] : "border-l-transparent"}`}>
        {starCell(trackOpen(e, live.mark, nowMs))}
        {traderCells(e.address, name, month)}
        <td className={`${tdClass} whitespace-nowrap font-medium`}>
          <span className="inline-flex items-center gap-1.5 align-middle">
            <TokenIcon ticker={e.coin} url={e.iconUrl ?? null} size="sm" />
            {e.coin}
          </span>
          <span className={`ml-1.5 text-xs ${e.side === "long" ? "text-positive" : "text-negative"}`}>{e.side === "long" ? "Long" : "Short"}</span>
        </td>
        <td className={`${tdClass} whitespace-nowrap ${ROLE_CLASS[role.role]}`} title={role.why}>
          {ROLE_LABEL[role.role]}
        </td>
        <td className={`${tdClass} whitespace-nowrap`}>
          {move ? (
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${MOVE_BADGE[move.kind]}`} title={new Date(move.at).toLocaleString()}>
              {MOVE_LABEL[move.kind]} {ago(move.at, nowMs)}
            </span>
          ) : (
            <span className="text-xs text-fg-muted" title="No open, add or trim within the fills read">
              —
            </span>
          )}
        </td>
        <td className={`${tdClass} whitespace-nowrap`}>
          {e.openedAt !== null ? ago(e.openedAt, nowMs) : e.openedBefore !== null ? <span className="text-fg-muted">over {ago(e.openedBefore, nowMs).replace(" ago", "")}</span> : "—"}
        </td>
        <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap`} title={`Position size; its share of their account and leverage${e.marginMode ? ` (${e.marginMode} margin)` : ""}`}>
          {formatCompactUsd(live.notionalUsd)}
          <span className="block text-xs text-fg-muted">
            {sharePct(e.equityShare)} · {e.leverage === null ? "—" : `${e.leverage}×`}
          </span>
        </td>
        <td className={tdClass}>
          {price(e.entryPx)}
          {e.openPx !== null && e.entryPx !== null && Math.abs(e.openPx / e.entryPx - 1) > 0.0005 && (
            <span className={`block text-xs text-fg-muted ${hideOnMobileClass}`} title="The price of the order that opened the position">
              first {price(e.openPx)}
            </span>
          )}
        </td>
        <td className={tdClass}>{price(live.mark)}</td>
        <td className={tdClass}>
          <span className={`font-medium ${toneOf(live.vsEntry)}`}>{signedPct(live.vsEntry)}</span>
          {live.vsOpen !== null && live.vsEntry !== null && Math.abs(live.vsOpen - live.vsEntry) > 0.0005 && (
            <span className={`block text-xs ${toneOf(live.vsOpen)} ${hideOnMobileClass}`} title="Since their first fill">
              {signedPct(live.vsOpen)} first
            </span>
          )}
        </td>
        <td className={`${tdClass} whitespace-nowrap`} title="Their return on margin: the move since their entry × their leverage (Hyperliquid's ROE); their PnL in dollars beside it">
          <span className={`font-medium ${toneOf(live.roe)}`}>{signedPct(live.roe)}</span>
          {live.pnlUsd !== null && <span className="block text-xs text-fg-muted">{formatUsdSigned(Math.round(live.pnlUsd))}</span>}
        </td>
        <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap`} title={e.tpslMore ? `${e.tpslMore} more TP/SL orders` : "Take-profit / stop-loss"}>
          {e.tpslKnown ? (
            <>
              {e.tp === null ? <span className="text-fg-muted">—</span> : price(e.tp)}
              <span className="text-fg-muted"> / </span>
              {e.sl === null ? <span className="text-fg-muted">none</span> : price(e.sl)}
            </>
          ) : (
            "?"
          )}
          {e.tpslMore > 0 && <span className="ml-1 text-xs text-fg-muted">+{e.tpslMore}</span>}
          {e.liquidationPx !== null && <span className="block text-xs text-fg-muted" title="Liquidation price">liq {price(e.liquidationPx)}</span>}
        </td>
      </tr>
    );
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["24h", "7d", "30d", "any"] as const).map((w) => (
          <button key={w} type="button" className={chipClass(window === w, true)} onClick={() => setWindow(w)} title={w === "any" ? "Every open position" : `Opened, added to or trimmed in the last ${w}`}>
            {w === "any" ? "Any time" : `Moved ${w}`}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        {(["both", "long", "short"] as const).map((s) => (
          <button key={s} type="button" className={chipClass(side === s, true)} onClick={() => setSide(s)}>
            {s === "both" ? "Long & short" : s === "long" ? "Longs" : "Shorts"}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        {(["all", "open", "closed"] as const).map((st) => (
          <button key={st} type="button" className={chipClass(status === st, true)} onClick={() => setStatus(st)}>
            {st === "all" ? "Open & closed" : st === "open" ? "Open" : "Closed"}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={betterOnly} onChange={(e) => setBetterOnly(e.target.checked)} />
          Only below their entry (above, for shorts)
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted" title="Hide hedges, pair trades and legs of balanced long/short books">
          <input type="checkbox" checked={directionalOnly} onChange={(e) => setDirectionalOnly(e.target.checked)} />
          Directional only
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted" title="One group per coin, the coins most traders hold first">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          Group by coin
        </label>
        {grouped && groups.length > 0 && (
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => setExpanded(expanded.size === groups.length ? new Set() : new Set(groups.map((g) => g.coin)))}>
            {expanded.size === groups.length ? "Collapse all" : "Expand all"}
          </button>
        )}
        {traders.length > 1 && (
          <select value={trader} onChange={(e) => setTrader(e.target.value)} className="ml-auto rounded-lg border border-border bg-surface px-2 py-1 text-xs text-fg">
            <option value="">All traders</option>
            {traders.map((a) => (
              <option key={a} value={a}>
                {names[a] ?? shortAddress(a)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={`${theadRowClass} whitespace-nowrap`}>
              <th className={`${tdClass} w-6 pr-0`} aria-label="Track" title="☆ marks a trade to follow in Tracked trades" />
              {h("Trader", "trader")}
              {h("Trader 30d", "trader30d", hideOnMobileClass)}
              {h("Coin", "coin")}
              {h("Role", "role")}
              {h("Last move", "move")}
              {h("Opened", "opened")}
              {h("Size", "notional", hideOnMobileClass)}
              {h("Their entry", "entry")}
              {h("Price now", "mark")}
              {h("vs entry", "vsEntry")}
              {h("Their gain", "pnl")}
              {h("TP / SL", "sl", hideOnMobileClass)}
            </tr>
          </thead>
          <tbody>
            {grouped
              ? groups.map((gr) => (
                  <Fragment key={gr.coin}>
                    <tr className="cursor-pointer border-b border-border bg-surface-raised/60 hover:bg-surface-raised" onClick={() => toggleCoin(gr.coin)}>
                      <td colSpan={COLUMNS} className="px-3 py-2 text-sm">
                        <button type="button" className="inline-flex items-center gap-1.5 align-middle font-semibold text-fg" aria-expanded={expanded.has(gr.coin)}>
                          <ChevronRight className={`size-3.5 text-fg-muted transition-transform ${expanded.has(gr.coin) ? "rotate-90" : ""}`} aria-hidden="true" />
                          <TokenIcon ticker={gr.coin} url={gr.rows.map(iconOf).find(Boolean) ?? null} size="sm" />
                          {gr.coin}
                        </button>
                        <span className="ml-3 text-fg-muted">
                          {gr.traders} trader{gr.traders === 1 ? "" : "s"}
                          {" · "}
                          {gr.longs > 0 && <span className="text-positive">{gr.longs} long</span>}
                          {gr.longs > 0 && gr.shorts > 0 && " / "}
                          {gr.shorts > 0 && <span className="text-negative">{gr.shorts} short</span>}
                          {gr.longs + gr.shorts > 0 && ` · ${gr.directional} directional · ${formatCompactUsd(gr.notionalUsd)}`}
                          {gr.avgEntry !== null && ` · avg entry ${formatPrice(gr.avgEntry)}`}
                          {gr.closed > 0 && <span className="text-fg">{`${gr.longs + gr.shorts > 0 ? " · " : ""}${gr.closed} closed`}</span>}
                        </span>
                        <GroupActivity rows={gr.rows} nowMs={nowMs} />
                      </td>
                    </tr>
                    {expanded.has(gr.coin) && gr.rows.map(renderRow)}
                  </Fragment>
                ))
              : rows.map(renderRow)}
          </tbody>
        </table>
        {trackError && <p className="mt-2 text-xs text-warning">Couldn&apos;t save the tracked trade: {trackError}</p>}
        {rows.length === 0 && <p className="py-6 text-center text-sm text-fg-muted">{entries.length === 0 ? "No open positions from the followed traders yet." : "No entry matches these filters."}</p>}
      </div>
    </>
  );
}

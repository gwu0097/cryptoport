"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { chipClass } from "@/components/ui/chip";
import { usePersistedState } from "@/components/usePersistedState";
import { useNowSec } from "@/components/useServerNow";
import { formatCompactUsd, formatPrice, formatUsdSigned } from "@/lib/format";
import { latestMove, liveFigures, positionRole, type MoveKind, type PositionRole, type ScoutEntry } from "@/lib/perpScout/entries";
import type { ScoutBook } from "@/lib/perpScoutScan";
import { groupByCoin } from "@/lib/perpScout/groups";
import { TokenIcon } from "@/components/TokenIcon";
import { ago, compareNullable, explorerUrl, hyperdashUrl, shortAddress, signedPct, sharePct, toneOf } from "./labels";

type SortKey = "trader" | "trader30d" | "role" | "coin" | "side" | "move" | "opened" | "notional" | "share" | "leverage" | "entry" | "open" | "mark" | "vsEntry" | "vsOpen" | "pnl" | "tp" | "sl" | "liq";
type Window = "24h" | "7d" | "30d" | "any";
const WINDOW_MS: Record<Window, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, any: Infinity };

interface Row {
  e: ScoutEntry;
  name: string;
  live: ReturnType<typeof liveFigures>;
  role: { role: PositionRole; why: string };
  /** The trader's perps PnL over the last 30 days, and as a share of their account. */
  month: { usd: number | null; share: number | null };
}

const ROLE_LABEL: Record<PositionRole, string> = { directional: "Directional", hedge: "Hedge", pair: "Paired", book: "Book leg" };
const ROLE_ORDER: Record<PositionRole, number> = { directional: 0, pair: 1, book: 2, hedge: 3 };
const ROLE_CLASS: Record<PositionRole, string> = { directional: "text-fg", pair: "text-fg-muted", book: "text-fg-muted", hedge: "text-warning" };

function sortValue(r: Row, key: SortKey): number | string | null {
  switch (key) {
    case "trader": return r.name.toLowerCase();
    case "trader30d": return r.month.usd;
    case "role": return ROLE_ORDER[r.role.role];
    case "move": return latestMove(r.e)?.at ?? null;
    case "coin": return r.e.coin.toLowerCase();
    case "side": return r.e.side;
    // Opened before the fills read sorts as just before that bound.
    case "opened": return r.e.openedAt ?? (r.e.openedBefore !== null ? r.e.openedBefore - 1 : null);
    case "notional": return r.live.notionalUsd;
    case "share": return r.e.equityShare;
    case "leverage": return r.e.leverage;
    case "entry": return r.e.entryPx;
    case "open": return r.e.openPx;
    case "mark": return r.live.mark;
    case "vsEntry": return r.live.vsEntry;
    case "vsOpen": return r.live.vsOpen;
    case "pnl": return r.live.roe;
    case "tp": return r.e.tp;
    case "sl": return r.e.sl;
    case "liq": return r.e.liquidationPx;
  }
}

/** Columns in the table, for a group's header row. */
const COLUMNS = 19;

const MOVE_LABEL: Record<MoveKind, string> = { new: "New", add: "Added", trim: "Trimmed" };
const MOVE_BADGE: Record<MoveKind, string> = { new: "bg-positive/15 text-positive", add: "bg-accent/15 text-accent", trim: "bg-warning/15 text-warning" };
/** A move this recent marks its row with its colour. */
const RECENT_MS = 24 * 60 * 60_000;
const MOVE_EDGE: Record<MoveKind, string> = { new: "border-l-positive", add: "border-l-accent", trim: "border-l-warning" };

/** A collapsed coin's activity: its latest move and how many of its
 * positions moved in the last 24 h. */
function GroupActivity({ rows, nowMs }: { rows: readonly Row[]; nowMs: number }) {
  const moves = rows.map((r) => latestMove(r.e)).filter((m): m is NonNullable<typeof m> => m !== null);
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
 * Every open position of the followed traders. Prices are the scan's marks
 * until Refresh prices swaps in current mids (`mids`). "vs entry" is the move
 * since their average entry in their direction: negative means they're down
 * and the price now is better than theirs.
 */
export function EntriesTable({ entries, books, names, mids, serverNowSec }: { entries: ScoutEntry[]; books: ScoutBook[]; names: Record<string, string>; mids: Record<string, number> | null; serverNowSec: number }) {
  const nowMs = useNowSec(serverNowSec) * 1000;
  const [sortKey, setSortKey] = usePersistedState<SortKey>("cryptoport:perpScoutEntriesSort", "opened");
  const [sortDir, setSortDir] = usePersistedState<"asc" | "desc">("cryptoport:perpScoutEntriesSortDir", "desc");
  const [window, setWindow] = usePersistedState<Window>("cryptoport:perpScoutWindow", "any");
  const [betterOnly, setBetterOnly] = usePersistedState("cryptoport:perpScoutBetterOnly", false);
  const [side, setSide] = usePersistedState<"both" | "long" | "short">("cryptoport:perpScoutSide", "both");
  const [trader, setTrader] = usePersistedState<string>("cryptoport:perpScoutTrader", "");
  const [directionalOnly, setDirectionalOnly] = usePersistedState("cryptoport:perpScoutDirectionalOnly", false);
  const [grouped, setGrouped] = usePersistedState("cryptoport:perpScoutGroupByCoin", false);
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
    const all: Row[] = entries.map((e) => {
      const b = bookOf.get(e.address);
      const usd = b?.stats?.monthPnl ?? null;
      return {
        e,
        name: names[e.address] ?? shortAddress(e.address),
        live: liveFigures(e, mids?.[e.coin]),
        role: positionRole(e, byTrader.get(e.address) ?? [e]),
        month: { usd, share: usd !== null && b?.accountValue ? usd / b.accountValue : null },
      };
    });
    return all
      .filter((r) => !directionalOnly || r.role.role === "directional")
      // Any move counts — opened, added to or trimmed: a position opened
      // weeks ago that the trader added to yesterday is recent activity.
      .filter((r) => {
        if (window === "any") return true;
        const move = latestMove(r.e);
        return move !== null && nowMs - move.at <= WINDOW_MS[window];
      })
      .filter((r) => !betterOnly || (r.live.vsEntry !== null && r.live.vsEntry < 0))
      .filter((r) => side === "both" || r.e.side === side)
      .filter((r) => !trader || r.e.address === trader)
      .sort((a, b) => compareNullable(sortValue(a, sortKey), sortValue(b, sortKey), sortDir));
  }, [entries, books, names, mids, window, betterOnly, side, trader, directionalOnly, sortKey, sortDir, nowMs]);

  const traders = useMemo(() => [...new Set(entries.map((e) => e.address))].sort((a, b) => (names[a] ?? a).localeCompare(names[b] ?? b)), [entries, names]);
  const h = (label: string, key: SortKey, className = "") => <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />;

  const groups = useMemo(
    () => groupByCoin(rows, (r) => ({ coin: r.e.coin, address: r.e.address, side: r.e.side, notionalUsd: r.live.notionalUsd, entryPx: r.e.entryPx, size: r.e.size, directional: r.role.role === "directional" })),
    [rows],
  );

  const renderRow = ({ e, name, live, role, month }: Row) => {
    const move = latestMove(e);
    const recent = move !== null && nowMs - move.at <= RECENT_MS;
    return (
      <tr key={`${e.address}:${e.coin}`} className={`${trClass} border-l-2 ${recent ? MOVE_EDGE[move.kind] : "border-l-transparent"}`}>
        <td className={tdClass}>
          <a href={explorerUrl(e.address)} target="_blank" rel="noreferrer" className="whitespace-nowrap hover:text-accent" title={e.address}>
            {name}
          </a>
          <a href={hyperdashUrl(e.address)} target="_blank" rel="noreferrer" className="ml-1.5 text-xs text-fg-muted hover:text-accent" title="Open on HyperDash">
            ↗
          </a>
        </td>
        <td className={`${tdClass} ${hideOnMobileClass} whitespace-nowrap ${toneOf(month.usd)}`} title="The trader's perps PnL over the last 30 days, and as a share of their account">
          {month.usd === null ? "—" : formatCompactUsd(month.usd)}
          {month.share !== null && <span className="ml-1 text-xs">{signedPct(month.share, 0)}</span>}
        </td>
        <td className={`${tdClass} whitespace-nowrap font-medium`}>
          <span className="inline-flex items-center gap-1.5 align-middle">
            <TokenIcon ticker={e.coin} url={e.iconUrl ?? null} size="sm" />
            {e.coin}
          </span>
          <span className={`ml-1.5 text-xs sm:hidden ${e.side === "long" ? "text-positive" : "text-negative"}`}>{e.side === "long" ? "L" : "S"}</span>
        </td>
        <td className={`${tdClass} whitespace-nowrap ${ROLE_CLASS[role.role]}`} title={role.why}>
          {ROLE_LABEL[role.role]}
        </td>
        <td className={`${tdClass} ${hideOnMobileClass} ${e.side === "long" ? "text-positive" : "text-negative"}`}>{e.side === "long" ? "Long" : "Short"}</td>
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
        <td className={`${tdClass} ${hideOnMobileClass}`}>{formatCompactUsd(live.notionalUsd)}</td>
        <td className={`${tdClass} ${hideOnMobileClass}`}>{sharePct(e.equityShare)}</td>
        <td className={`${tdClass} ${hideOnMobileClass}`} title={e.marginMode ?? undefined}>
          {e.leverage === null ? "—" : `${e.leverage}×`}
        </td>
        <td className={tdClass}>{price(e.entryPx)}</td>
        <td className={`${tdClass} ${hideOnMobileClass}`}>{price(e.openPx)}</td>
        <td className={tdClass}>{price(live.mark)}</td>
        <td className={`${tdClass} font-medium ${toneOf(live.vsEntry)}`}>{signedPct(live.vsEntry)}</td>
        <td className={`${tdClass} ${hideOnMobileClass} ${toneOf(live.vsOpen)}`}>{signedPct(live.vsOpen)}</td>
        <td className={`${tdClass} whitespace-nowrap`} title="Their return on margin: the move since their entry × their leverage (Hyperliquid's ROE); their PnL in dollars beside it">
          <span className={`font-medium ${toneOf(live.roe)}`}>{signedPct(live.roe)}</span>
          {live.pnlUsd !== null && <span className="ml-1.5 text-xs text-fg-muted">{formatUsdSigned(Math.round(live.pnlUsd))}</span>}
        </td>
        <td className={`${tdClass} ${hideOnMobileClass}`}>{e.tpslKnown ? price(e.tp) : "?"}</td>
        <td className={`${tdClass} ${hideOnMobileClass}`} title={e.tpslMore ? `${e.tpslMore} more TP/SL orders` : undefined}>
          {e.tpslKnown ? e.sl === null ? <span className="text-fg-muted">none</span> : price(e.sl) : "?"}
          {e.tpslMore > 0 && <span className="ml-1 text-xs text-fg-muted">+{e.tpslMore}</span>}
        </td>
        <td className={`${tdClass} ${hideOnMobileClass}`}>{price(e.liquidationPx)}</td>
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
              {h("Trader", "trader")}
              {h("Trader 30d", "trader30d", hideOnMobileClass)}
              {h("Coin", "coin")}
              {h("Role", "role")}
              {h("Side", "side", hideOnMobileClass)}
              {h("Last move", "move")}
              {h("Opened", "opened")}
              {h("Size", "notional", hideOnMobileClass)}
              {h("% equity", "share", hideOnMobileClass)}
              {h("Lev", "leverage", hideOnMobileClass)}
              {h("Their entry", "entry")}
              {h("First fill", "open", hideOnMobileClass)}
              {h("Price now", "mark")}
              {h("vs entry", "vsEntry")}
              {h("vs first fill", "vsOpen", hideOnMobileClass)}
              {h("Their gain", "pnl")}
              {h("TP", "tp", hideOnMobileClass)}
              {h("SL", "sl", hideOnMobileClass)}
              {h("Liq.", "liq", hideOnMobileClass)}
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
                          <TokenIcon ticker={gr.coin} url={gr.rows[0].e.iconUrl ?? null} size="sm" />
                          {gr.coin}
                        </button>
                        <span className="ml-3 text-fg-muted">
                          {gr.traders} trader{gr.traders === 1 ? "" : "s"}
                          {" · "}
                          {gr.longs > 0 && <span className="text-positive">{gr.longs} long</span>}
                          {gr.longs > 0 && gr.shorts > 0 && " / "}
                          {gr.shorts > 0 && <span className="text-negative">{gr.shorts} short</span>}
                          {` · ${gr.directional} directional · ${formatCompactUsd(gr.notionalUsd)}`}
                          {gr.avgEntry !== null && ` · avg entry ${formatPrice(gr.avgEntry)}`}
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
        {rows.length === 0 && <p className="py-6 text-center text-sm text-fg-muted">{entries.length === 0 ? "No open positions from the followed traders yet." : "No entry matches these filters."}</p>}
      </div>
    </>
  );
}

"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Eye, EyeOff, RefreshCw } from "lucide-react";
import type { WatchCoinDay, WatchDayActivity } from "@/lib/watchQuery";
import type { CoinTrade } from "@/lib/watchActivity";
import { foldSoldOut, soldOut } from "@/lib/activityFold";
import { fetchDelay, minutesLeft } from "@/lib/liveWatching";
import { useWatching } from "./useWatching";
import { onLiveActivity } from "@/lib/liveListener";
import { formatCompactUsd, formatPercent, formatPrice, formatQty, formatUsd, formatUsdSigned } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";
import { AgeText } from "@/components/AgeText";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/CopyButton";

/**
 * Live updates (phase 5): when any shown influencer is live, listen for the
 * server's "new activity" broadcast and fetch just these lines. How soon is
 * the viewer's choice (liveWatching.ts): about a second with "Watching" on
 * (at most every 15 s, for an hour), else at most every 30 minutes — in a
 * background tab alike. Nothing polls; without live influencers nothing
 * listens.
 */
function useLiveDay(ids: readonly string[], live: boolean, watching: boolean, serverCoins: readonly WatchCoinDay[]): WatchDayActivity | null {
  const [fresh, setFresh] = useState<WatchDayActivity | null>(null);
  // A new server render (navigation, router.refresh) supersedes what was fetched.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFresh(null);
  }, [serverCoins]);
  const key = ids.join(",");
  useEffect(() => {
    if (!live || !key) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The page was just rendered (fresh), unless the viewer turned Watching
    // on: then fetch at once, to start from the latest.
    let last = Date.now();
    const fetchNow = async () => {
      last = Date.now();
      const res = await fetch(`/api/wallet-watch/day?ids=${key}`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setFresh((await res.json()) as WatchDayActivity);
    };
    if (watching) void fetchNow();
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void fetchNow();
      }, fetchDelay(last, Date.now(), watching));
    };
    const unsubscribe = onLiveActivity(schedule); // the tab's one shared channel
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [live, key, watching]);
  return fresh;
}

/** The viewer's "Watching" switch: fast live updates for an hour. */
function WatchingSwitch({ watching, until, nowMs, start, stop }: ReturnType<typeof useWatching>) {
  return (
    <button
      type="button"
      onClick={watching ? stop : start}
      aria-pressed={watching}
      title={
        watching
          ? "New trades show about a second after they land. Turns itself off after an hour — click to stop now."
          : "Show new trades about a second after they land, for the next hour. Off, this panel picks them up at most every 30 minutes (or Refresh activity)."
      }
      className={`ml-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        watching ? "border-positive/50 bg-positive/15 text-positive" : "border-border text-fg-muted hover:text-fg"
      }`}
    >
      {watching ? <Eye className="size-3" aria-hidden="true" /> : <EyeOff className="size-3" aria-hidden="true" />}
      {watching && until !== null ? `Watching · ${minutesLeft(until, nowMs)}m left` : "Watch"}
    </button>
  );
}

/** Runs the activity check for these influencers, streaming one line per
 * address (api/wallet-watch/check) — no polling — then re-renders the page.
 * Sits in the activity panel's header. */
export function ActivityCheckButton({ influencerIds }: { influencerIds: string[] }) {
  const router = useRouter();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      const res = await fetch("/api/wallet-watch/check", { method: "POST", body: JSON.stringify({ influencerIds }) });
      if (!res.ok || !res.body) throw new Error(`Refresh failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = JSON.parse(buffer.slice(0, nl)) as { type: string; total?: number; error?: string };
          buffer = buffer.slice(nl + 1);
          if (line.type === "start") setProgress({ done: 0, total: line.total ?? 0 });
          else if (line.type === "address") setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
          else if (line.type === "error") setError(line.error ?? "Refresh failed");
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
      router.refresh();
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={progress !== null || influencerIds.length === 0}
        onClick={check}
        title="Reads each wallet's transactions since its last check — seconds, not a full re-read. A wallet checked in the last 15 minutes is reused."
      >
        <RefreshCw className={`size-3.5 ${progress ? "animate-spin" : ""}`} aria-hidden="true" />
        {progress ? (progress.total > 0 ? `Checking ${progress.done}/${progress.total}…` : "Checking…") : "Refresh activity"}
      </Button>
      {error && <span className="text-xs font-normal text-warning">{error}</span>}
    </span>
  );
}

const compactQty = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : formatQty(n));
const pay = (n: number | null, ticker: string | null) => (n !== null && ticker ? `${n < 1 ? n.toFixed(3) : n.toFixed(2)} ${ticker}` : null);
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The window the table covers, in words: "today" (the day's activity) or
 * "in 7 days" (Recent trades) — its results and dates follow it. */
const PeriodContext = createContext("today");

type SortKey = "trader" | "coin" | "bought" | "sold" | "result" | "when";
type Sort = { key: SortKey; dir: "asc" | "desc" };

function sortValue(c: WatchCoinDay, key: SortKey): number | string {
  switch (key) {
    case "trader":
      return c.influencerName.toLowerCase();
    case "coin":
      return c.ticker.toLowerCase();
    case "bought":
      return c.boughtUsd ?? 0;
    case "sold":
      return c.soldUsd ?? 0;
    case "result":
      return c.realizedUsd ?? -Infinity;
    case "when":
      return Date.parse(c.lastAt);
  }
}

/** "Buy 0.18 SOL → 814K WATCH" — a trade in words. */
function tradeText(t: CoinTrade, ticker: string): string {
  const cash = pay(t.payQty, t.payTicker);
  if (t.side === "buy" && cash) return `${cash} → ${compactQty(t.qty)} ${ticker}`;
  if (t.side === "sell" && cash) return `${compactQty(t.qty)} ${ticker} → ${cash}`;
  return `${compactQty(t.qty)} ${ticker}`;
}
const SIDE: Record<CoinTrade["side"], string> = { buy: "Buy", sell: "Sell", received: "Received", sent: "Sent" };
const sideTone = (t: CoinTrade) => (t.side === "buy" || t.side === "received" ? "text-positive" : "text-negative");

/** "Buy 1.00 SOL ($118) at $0.0002516 · 3:28 PM" — the latest trade: what
 * was paid and the price, not the token count (owner 2026-09-28). */
function LastTrade({ t, ticker, at }: { t: CoinTrade; ticker: string; at: (price: number) => string }) {
  const when = useContext(PeriodContext) === "today" ? TIME : DATE_TIME;
  const cash = pay(t.payQty, t.payTicker);
  const price = t.usd !== null && t.qty > 0 ? t.usd / t.qty : null;
  return (
    <>
      <span className={sideTone(t)}>{SIDE[t.side]}</span>{" "}
      <span className="text-fg">{cash ?? `${compactQty(t.qty)} ${ticker}`}</span>
      {t.usd !== null && <span className="text-fg-muted"> ({formatUsd(t.usd)})</span>}
      {price !== null && <span className="text-fg"> at {at(price)}</span>}
      <span className="text-fg-muted"> · {when.format(new Date(t.at))}</span>
    </>
  );
}

/** Bought or sold: the cash side and its dollar value. */
function Amount({ payQty, usd, ticker, qty, tone }: { payQty: number | null; usd: number | null; ticker: string | null; qty: number; tone: string }) {
  if (qty <= 0) return <span className="text-fg-muted">—</span>;
  return (
    <span className={tone}>
      {pay(payQty, ticker) ?? compactQty(qty)}
      {usd !== null && <span className="text-xs text-fg-muted"> ({formatUsd(usd)})</span>}
    </span>
  );
}

/** A price older than this is shown orange, with its age (owner: a value at
 * an hour-old price read as current — Risk's WATCH at $575, really ~$313). */
const STALE_PRICE_MS = 15 * 60 * 1000;

/** The freshest price we have for a coin: the stored one, or its latest
 * trade's own price when that's newer — with when and where it's from. */
function freshestPrice(c: WatchCoinDay, refreshed: Refreshed | null): { usd: number; at: string; from: "stored" | "last trade" } | null {
  const t = c.trades.find((x) => x.usd !== null && x.qty > 0);
  const trade = t ? { usd: t.usd! / t.qty, at: t.at, from: "last trade" as const } : null;
  const stored = refreshed ? { usd: refreshed.usd, at: refreshed.at, from: "stored" as const } : c.nowUsd !== null && c.nowAt ? { usd: c.nowUsd, at: c.nowAt, from: "stored" as const } : null;
  if (!trade) return stored;
  if (!stored) return trade;
  return Date.parse(trade.at) > Date.parse(stored.at) ? trade : stored;
}

/** A coin's price and market cap fetched by the row's refresh button. */
type Refreshed = { usd: number; at: string; marketCap: number | null };

/** The row's refresh button: just this coin's latest price (one call to its
 * source, api/wallet-watch/coin-price), then the row values with it. */
function CoinPriceButton({ priceKey, ticker, onPrice }: { priceKey: string; ticker: string; onPrice: (p: Refreshed) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wallet-watch/coin-price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priceKey }) });
      const body = (await res.json()) as { usd?: number | null; marketCap?: number | null; at?: string | null; error?: string };
      if (!res.ok || body.usd == null || !body.at) throw new Error(body.error ?? "no price");
      onPrice({ usd: body.usd, at: body.at, marketCap: body.marketCap ?? null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={refresh}
      disabled={busy}
      className={`ml-1 inline-flex align-middle ${error ? "text-warning" : "text-fg-muted"} hover:text-fg disabled:opacity-50`}
      title={error ? `Couldn't get ${ticker}'s price: ${error}` : `Get ${ticker}'s latest price`}
      aria-label={`Refresh ${ticker}'s price`}
    >
      <RefreshCw className={`size-3 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
    </button>
  );
}

/** One coin's row, and its trades underneath when opened. */
function CoinRows({ c, isNew, showNames, serverNowSec, nested = false }: { c: WatchCoinDay; isNew: boolean; showNames: boolean; serverNowSec: number; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [refreshed, setRefreshed] = useState<Refreshed | null>(null);
  const period = useContext(PeriodContext);
  const closed = soldOut(c);
  // The market cap at a price (circulating supply × price) — how the table
  // shows prices (owner 2026-09-29); the price itself when the supply isn't known.
  const supply = refreshed?.marketCap && refreshed.usd ? refreshed.marketCap / refreshed.usd : c.supply;
  const at = (p: number) => (supply ? `MC ${formatCompactUsd(p * supply)}` : formatPrice(p));
  // Nothing sold, but all of it sent to another wallet (AGI: 71 buys, then
  // 2.30M out): not "open" at $0.
  const sentOut = !closed && c.sells === 0 && c.holdingQty <= 0 && c.trades.some((t) => t.side === "sent");
  const price = freshestPrice(c, refreshed);
  const stale = price !== null && serverNowSec * 1000 - Date.parse(price.at) > STALE_PRICE_MS;
  const priceNote = price ? `Price ${formatPrice(price.usd)} as of ${TIME.format(new Date(price.at))} (${price.from === "last trade" ? "their last trade" : "last price refresh"})${stale ? " — stale" : ""}` : "";
  const holdingUsd = price !== null ? c.holdingQty * price.usd : null;
  const sinceEntry = c.avgEntryUsd && price !== null && !closed ? ((price.usd - c.avgEntryUsd) / c.avgEntryUsd) * 100 : null;
  const cols = showNames ? 8 : 7;
  return (
    <>
      <tr className={nested ? `${trClass} ${NESTED_ROW}` : trClass}>
        {showNames && (
          <td className={tdClass}>
            {nested ? (
              // Inside an opened group: the trader is the group's row above.
              <span className="pl-2 text-fg-muted" aria-hidden="true">↳</span>
            ) : (
              <>
                {isNew && <span className="mr-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">new</span>}
                <Link href={`/wallet-watch/${c.influencerId}`} className="font-medium text-fg hover:underline">
                  {c.influencerName}
                </Link>
              </>
            )}
          </td>
        )}
        <td className={tdClass}>
          {!showNames && isNew && <span className="mr-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">new</span>}
          <span className="font-semibold text-fg">{c.ticker}</span>
          {c.contract && (
            <span className="ml-1 inline-flex align-middle">
              <CopyButton value={c.contract} label={`Copy ${c.ticker} contract`} title={`Copy ${c.ticker}'s contract${c.contractChain ? ` (${c.contractChain})` : ""}: ${c.contract}`} />
            </span>
          )}
          <p className="text-xs text-fg-muted">
            {c.buys} buy{c.buys === 1 ? "" : "s"} · {c.sells} sell{c.sells === 1 ? "" : "s"}
          </p>
          {/* The latest trade on its own line: a new one replaces it, and it rolls into the totals. */}
          <p className="text-xs">
            <span className="text-fg-muted">Last: </span>
            <LastTrade t={c.trades[0]} ticker={c.ticker} at={at} />
          </p>
        </td>
        <td className={`${tdClass} tabular-nums`}>
          <Amount payQty={c.boughtPay} usd={c.boughtUsd} ticker={c.payTicker} qty={c.boughtQty} tone="text-positive" />
          {c.avgEntryUsd !== null && (
            <p className="text-xs text-fg-muted">
              avg entry {at(c.avgEntryUsd)}
              {c.entryLiqUsd !== null && <span title="The coin's liquidity when the position opened (live updates only)"> · Liq {formatCompactUsd(c.entryLiqUsd)}</span>}
            </p>
          )}
        </td>
        <td className={`${tdClass} tabular-nums`}>
          <Amount payQty={c.soldPay} usd={c.soldUsd} ticker={c.payTicker} qty={c.soldQty} tone="text-negative" />
          {c.avgExitUsd !== null && <p className="text-xs text-fg-muted">avg exit {at(c.avgExitUsd)}</p>}
        </td>
        <td className={`${tdClass} tabular-nums`}>
          {closed ? (
            // "sold all" only when nothing's left; a crumb under $1 says so.
            <>
              <span className="text-fg-muted">{c.holdingQty <= 0 ? "sold all" : "dust left"}</span>
              {c.priceKey && <CoinPriceButton priceKey={c.priceKey} ticker={c.ticker} onPrice={setRefreshed} />}
              {/* Sold out: the coin's market cap now, in place of a value. */}
              {price !== null && supply && (
                <p className={`text-xs ${stale ? "text-warning" : "text-fg-muted"}`} title={priceNote}>
                  MC now {formatCompactUsd(price.usd * supply)}
                  {stale && " ⚠"}
                </p>
              )}
            </>
          ) : sentOut ? (
            <span className="text-fg-muted">sent out</span>
          ) : (
            <>
              {compactQty(c.holdingQty)}
              {c.priceKey && <CoinPriceButton priceKey={c.priceKey} ticker={c.ticker} onPrice={setRefreshed} />}
              {holdingUsd !== null && (
                <p className={`text-xs ${stale ? "text-warning" : "text-fg-muted"}`} title={priceNote}>
                  {formatUsd(holdingUsd)}
                  {/* The coin's market cap now, next to what the position is worth. */}
                  {price !== null && supply ? ` (MC ${formatCompactUsd(price.usd * supply)})` : ""}
                  {stale && " ⚠"}
                </p>
              )}
            </>
          )}
        </td>
        <td className={`${tdClass} tabular-nums`}>
          {c.realizedUsd !== null ? (
            <span className={c.realizedUsd >= 0 ? "text-positive" : "text-negative"} title={`Result of the part bought and sold ${period}`}>
              {formatUsdSigned(c.realizedUsd)}
              {c.realizedPct !== null && <span className="block text-xs">{formatPercent(c.realizedPct)} on what was sold</span>}
              {/* Still holding the rest: how that part is doing (what KOLScan's ROI also counts). */}
              {sinceEntry !== null && (
                <span className={`block text-xs ${stale ? "text-warning" : sinceEntry >= 0 ? "text-positive" : "text-negative"}`} title={`${priceNote} vs average entry`}>
                  rest {formatPercent(sinceEntry)} since entry
                </span>
              )}
            </span>
          ) : sentOut ? (
            <span className="text-fg-muted" title="Sent to another wallet — its result isn't known here">
              moved to another wallet
            </span>
          ) : c.soldShareOfPosition !== null ? (
            <span className="text-negative">sold {Math.round(c.soldShareOfPosition * 100)}% of position</span>
          ) : (
            <span className="text-fg-muted">
              open
              {sinceEntry !== null && (
                <span className={`block text-xs ${stale ? "text-warning" : sinceEntry >= 0 ? "text-positive" : "text-negative"}`} title={`${priceNote} vs average entry`}>
                  {formatPercent(sinceEntry)} since entry
                </span>
              )}
            </span>
          )}
        </td>
        <td className={`${tdClass} text-right`}>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="whitespace-nowrap text-xs text-fg-muted hover:text-fg" title="Show its trades">
            <AgeText at={c.lastAt} serverNowSec={serverNowSec} /> {open ? "▴" : "▾"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className={`border-b border-border/60 ${nested ? NESTED_ROW : ""}`}>
          <td colSpan={cols} className="px-3 pb-3">
            <ul className="space-y-0.5 border-l border-border/60 pl-3 text-xs">
              {c.trades.map((t) => (
                <li key={`${t.txId}|${t.side}`} className="flex flex-wrap justify-between gap-x-3">
                  <span>
                    <span className={sideTone(t)}>{SIDE[t.side]}</span> {tradeText(t, c.ticker)}
                    {t.usd !== null && <span className="text-fg-muted"> ({formatUsd(t.usd)}{t.qty > 0 ? ` · ${supply ? at(t.usd / t.qty) : `${formatPrice(t.usd / t.qty)} each`}` : ""})</span>}
                  </span>
                  <span className="text-fg-muted">
                    {(period === "today" ? TIME : DATE_TIME).format(new Date(t.at))}
                    {t.source === "webhook" && " · live"}
                  </span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

/** An opened group's coin rows: tinted, with the group's accent edge, so
 * they read as the group's (owner 2026-09-30: which row closes it?). */
const NESTED_ROW = "bg-surface-raised/40 [&>td:first-child]:border-l-2 [&>td:first-child]:border-accent/50";

/** A trader's sold-out coins on one row: how many, totals, net result
 * and the tickers colored by result — their coin rows behind a toggle. */
function TraderGroup({ coins, latest, showNames, serverNowSec }: { coins: WatchCoinDay[]; latest: number; showNames: boolean; serverNowSec: number }) {
  const [open, setOpen] = useState(false);
  const period = useContext(PeriodContext);
  const first = coins[0];
  const sum = (f: (c: WatchCoinDay) => number | null) => coins.reduce((s, c) => s + (f(c) ?? 0), 0);
  const realized = sum((c) => c.realizedUsd);
  const lastAt = coins.map((c) => c.lastAt).sort().at(-1)!;
  const isNew = coins.some((c) => Date.parse(c.firstCheckedAt) >= latest);
  const byResult = [...coins].sort((a, b) => Math.abs(b.realizedUsd ?? 0) - Math.abs(a.realizedUsd ?? 0));
  return (
    <>
      <tr
        className={`${trClass} cursor-pointer ${open ? "bg-surface-raised [&>td:first-child]:border-l-2 [&>td:first-child]:border-accent" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? "Hide these coins" : "Show these coins"}
      >
        {showNames && (
          <td className={tdClass}>
            {isNew && <span className="mr-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">new</span>}
            <Link href={`/wallet-watch/${first.influencerId}`} onClick={(e) => e.stopPropagation()} className="font-medium text-fg hover:underline">
              {first.influencerName}
            </Link>
          </td>
        )}
        <td className={tdClass}>
          {!showNames && isNew && <span className="mr-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">new</span>}
          <span className="inline-flex items-center gap-1 font-semibold text-fg">
            {open ? <ChevronDown className="size-4 text-accent" aria-hidden="true" /> : <ChevronRight className="size-4 text-fg-muted" aria-hidden="true" />}
            {coins.length} coins sold out {period}
          </span>
          <p className="text-xs text-fg-muted">
            {sum((c) => c.buys)} buys · {sum((c) => c.sells)} sells
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs">
            {byResult.map((c) => (
              <span key={c.assetKey} className={c.realizedUsd === null ? "text-fg-muted" : c.realizedUsd >= 0 ? "text-positive" : "text-negative"} title={c.realizedUsd !== null ? formatUsdSigned(c.realizedUsd) : "still open"}>
                {c.ticker}
              </span>
            ))}
          </p>
        </td>
        <td className={`${tdClass} tabular-nums text-positive`}>{formatUsd(sum((c) => c.boughtUsd))}</td>
        <td className={`${tdClass} tabular-nums text-negative`}>{formatUsd(sum((c) => c.soldUsd))}</td>
        <td className={`${tdClass} text-fg-muted`}>sold all</td>
        <td className={`${tdClass} tabular-nums`}>
          <span className={realized >= 0 ? "text-positive" : "text-negative"} title={`Net result of what was bought and sold ${period}`}>
            {formatUsdSigned(realized)}
          </span>
          <span className="block text-xs text-fg-muted">net, sold {period}</span>
        </td>
        <td className={`${tdClass} text-right`}>
          <span className="whitespace-nowrap text-xs text-fg-muted">
            <AgeText at={lastAt} serverNowSec={serverNowSec} /> {open ? "▴" : "▾"}
          </span>
        </td>
      </tr>
      {open && coins.map((c) => <CoinRows key={c.assetKey} c={c} isNew={Date.parse(c.firstCheckedAt) >= latest} showNames={showNames} serverNowSec={serverNowSec} nested />)}
    </>
  );
}

/** The coins as a sortable table (site convention: SortableHeader +
 * usePersistedState), newest activity first by default. `period` words the
 * window ("today"; Recent trades: "in 7 days"). */
export function CoinTable({
  coins,
  latest,
  showNames,
  serverNowSec,
  period = "today",
  dense = false,
}: {
  coins: WatchCoinDay[];
  latest: number;
  showNames: boolean;
  serverNowSec: number;
  period?: string;
  /** Tighter rows (the Dashboard's card). */
  dense?: boolean;
}) {
  const [sort, setSort] = usePersistedState<Sort>("cryptoport:watchActivitySort", { key: "when", dir: "desc" });
  const { key: sortKey, dir: sortDir } = sort;
  const toggleSort = (key: SortKey) => setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  const sorted = [...coins].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });
  const head = (label: string, key: SortKey, className = "") => <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />;
  // Every trader alike: sold-out coins fold into one row (activityFold.ts).
  const items = foldSoldOut(sorted);
  return (
    <PeriodContext.Provider value={period}>
    <div className={`mt-1 max-h-[34rem] overflow-auto overscroll-contain ${dense ? "[&_td]:py-2 [&_th]:py-1.5" : ""}`}>
      <table className={tableClass}>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className={theadRowClass}>
            {showNames && head("Trader", "trader")}
            {head("Coin", "coin")}
            {head("Bought", "bought")}
            {head("Sold", "sold")}
            {/* Shown on phones too: its refresh is the only way to price one coin. */}
            <th className={thClass}>Holding</th>
            {head("Result", "result")}
            {head("When", "when", "text-right")}
          </tr>
        </thead>
        <tbody>
          {items.map((it) =>
            it.kind === "coin" ? (
              <CoinRows key={`${it.c.influencerId}|${it.c.assetKey}`} c={it.c} isNew={Date.parse(it.c.firstCheckedAt) >= latest} showNames={showNames} serverNowSec={serverNowSec} />
            ) : (
              <TraderGroup key={it.coins[0].influencerId} coins={it.coins} latest={latest} showNames={showNames} serverNowSec={serverNowSec} />
            ),
          )}
        </tbody>
      </table>
    </div>
    </PeriodContext.Provider>
  );
}

/** The day's lines for these influencers: the server's, then live updates
 * (useLiveDay) while `enabled` — a hidden tab doesn't listen (each live
 * update would fetch api/wallet-watch/day). */
export function useDayActivity({
  coins: serverCoins,
  checkedAt: serverCheckedAt,
  issues: serverIssues,
  liveIds = [],
  influencerIds,
  enabled = true,
}: {
  coins: WatchCoinDay[];
  checkedAt: string | null;
  issues: { address: string; status: string }[];
  liveIds?: string[];
  influencerIds: string[];
  enabled?: boolean;
}) {
  const live = liveIds.some((id) => influencerIds.includes(id));
  const watch = useWatching();
  const fresh = useLiveDay(influencerIds, live && enabled, watch.watching, serverCoins);
  const shown = new Set(influencerIds);
  const coins = fresh ? fresh.coins.filter((c) => shown.has(c.influencerId)) : serverCoins;
  const issues = fresh ? fresh.issues.filter((i) => shown.has(i.influencerId)) : serverIssues;
  const checkedAt = fresh ? (influencerIds.map((id) => fresh.checkedAt[id]).filter(Boolean).sort().at(-1) ?? serverCheckedAt) : serverCheckedAt;
  // Found by the latest check (the ones before it were already there).
  const latest = checkedAt ? Date.parse(checkedAt) - 60_000 : Infinity;
  return { coins, issues, checkedAt, latest, live, watch };
}

/** LIVE, the Watching switch, when last checked, and addresses not fully
 * checked (a chip; hover for why). */
export function DayStatus({
  live,
  watch,
  checkedAt,
  issues,
  serverNowSec,
}: {
  live: boolean;
  watch: ReturnType<typeof useWatching>;
  checkedAt: string | null;
  issues: { address: string; status: string }[];
  serverNowSec: number;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      {live && (
        <>
          <span className="rounded bg-positive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-positive" title="Trades arrive by webhook as they happen (Helius for Solana, Alchemy for Ethereum, Arbitrum and Robinhood Chain); this panel shows them within a second while Watching, else within 30 minutes.">
            live
          </span>
          <WatchingSwitch {...watch} />
        </>
      )}
      <span className="text-fg-muted">{checkedAt ? <AgeText at={checkedAt} serverNowSec={serverNowSec} prefix="checked " /> : "not checked yet"}</span>
      {issues.length > 0 && (
        <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning" title={`${issues.map((i) => `${i.address.slice(0, 8)}…: ${i.status}`).join("\n")}\nThis morning's read covers them.`}>
          {issues.length} not fully checked
        </span>
      )}
    </span>
  );
}

/** The table, or what to say when there's nothing in it. */
export function DayTable({
  coins,
  latest,
  checkedAt,
  live,
  showNames = true,
  serverNowSec,
  dense = false,
}: {
  coins: WatchCoinDay[];
  latest: number;
  checkedAt: string | null;
  live: boolean;
  showNames?: boolean;
  serverNowSec: number;
  dense?: boolean;
}) {
  if (coins.length === 0) {
    return <p className="mt-2 text-sm text-fg-muted">{checkedAt || live ? "No trades since this morning's read." : "Refresh activity to see what they've done since this morning's read."}</p>;
  }
  return <CoinTable coins={coins} latest={latest} showNames={showNames} serverNowSec={serverNowSec} dense={dense} />;
}

/** What the table shows, in one sentence (a footnote, or an info tooltip). */
export const DAY_ACTIVITY_NOTE =
  "Per coin since this morning's read — click a row's time for its trades. Results count what was bought and sold today; a trim of an earlier position shows its share.";

/**
 * Wallet Watch's activity since the morning read, per coin (like a trading
 * app's token cards), from the activity check and live updates (phases 4–5).
 * Cash coins (SOL, USDC, ETH) appear only as what trades were paid with.
 * The Dashboard composes the same parts in its card's header instead
 * (useDayActivity, DayStatus, DayTable).
 */
export function DayActivity({
  coins,
  checkedAt,
  issues,
  liveIds = [],
  influencerIds,
  serverNowSec,
  showNames = true,
}: {
  coins: WatchCoinDay[];
  /** The latest check of these influencers' addresses. */
  checkedAt: string | null;
  issues: { address: string; status: string }[];
  /** Shown influencers on live updates: the panel listens for new activity. */
  liveIds?: string[];
  influencerIds: string[];
  serverNowSec: number;
  showNames?: boolean;
}) {
  const day = useDayActivity({ coins, checkedAt, issues, liveIds, influencerIds });
  return (
    <div className="mb-4 rounded-lg border border-border/60 bg-surface-raised/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
          <span className="font-semibold text-fg">Since this morning&apos;s read</span>
          <DayStatus live={day.live} watch={day.watch} checkedAt={day.checkedAt} issues={day.issues} serverNowSec={serverNowSec} />
        </p>
        <ActivityCheckButton influencerIds={influencerIds} />
      </div>
      <DayTable coins={day.coins} latest={day.latest} checkedAt={day.checkedAt} live={day.live} showNames={showNames} serverNowSec={serverNowSec} />
      <p className="mt-1 text-[11px] text-fg-muted/80">{DAY_ACTIVITY_NOTE}</p>
    </div>
  );
}

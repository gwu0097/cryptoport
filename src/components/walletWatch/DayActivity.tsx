"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { WatchCoinDay, WatchDayActivity } from "@/lib/watchQuery";
import type { CoinTrade } from "@/lib/watchActivity";
import { foldSoldOut, soldOut } from "@/lib/activityFold";
import { ACTIVITY_CHANNEL, ACTIVITY_EVENT, LIVE_REFETCH_MS } from "@/lib/liveChannel";
import { browserSupabase } from "@/lib/supabaseBrowser";
import { formatPercent, formatPrice, formatQty, formatUsd, formatUsdSigned } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";
import { AgeText } from "@/components/AgeText";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/CopyButton";

/**
 * Live updates (phase 5): when any shown influencer is live, listen for the
 * server's "new activity" broadcast and fetch just these lines — at most once
 * a minute, and only while the tab is visible (a hidden tab catches up once
 * when shown). Nothing polls; without live influencers nothing listens.
 */
const CATCH_UP_AFTER_HIDDEN_MS = 30_000;

function useLiveDay(ids: readonly string[], live: boolean, serverCoins: readonly WatchCoinDay[]): WatchDayActivity | null {
  const [fresh, setFresh] = useState<WatchDayActivity | null>(null);
  // A new server render (navigation, router.refresh) supersedes what was fetched.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFresh(null);
  }, [serverCoins]);
  const key = ids.join(",");
  useEffect(() => {
    if (!live || !key) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    const fetchNow = async () => {
      if (document.visibilityState !== "visible") {
        pending = true;
        return;
      }
      pending = false;
      last = Date.now();
      const res = await fetch(`/api/wallet-watch/day?ids=${key}`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setFresh((await res.json()) as WatchDayActivity);
    };
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void fetchNow();
      }, Math.max(0, last + LIVE_REFETCH_MS - Date.now()));
    };
    // A background tab can lose its connection without a word (Chrome
    // throttles hidden tabs): coming back after a while, or reconnecting,
    // catches up once instead of trusting that nothing was missed.
    let hiddenAt: number | null = null;
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt !== null && Date.now() - hiddenAt > CATCH_UP_AFTER_HIDDEN_MS;
      hiddenAt = null;
      if (pending || away) schedule();
    };
    let dropped = false;
    const supabase = browserSupabase();
    const channel = supabase
      .channel(ACTIVITY_CHANNEL)
      .on("broadcast", { event: ACTIVITY_EVENT }, schedule)
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED" && dropped) schedule();
        if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") dropped = true;
      });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [live, key]);
  return fresh;
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
function LastTrade({ t, ticker }: { t: CoinTrade; ticker: string }) {
  const cash = pay(t.payQty, t.payTicker);
  const price = t.usd !== null && t.qty > 0 ? t.usd / t.qty : null;
  return (
    <>
      <span className={sideTone(t)}>{SIDE[t.side]}</span>{" "}
      <span className="text-fg">{cash ?? `${compactQty(t.qty)} ${ticker}`}</span>
      {t.usd !== null && <span className="text-fg-muted"> ({formatUsd(t.usd)})</span>}
      {price !== null && <span className="text-fg"> at {formatPrice(price)}</span>}
      <span className="text-fg-muted"> · {TIME.format(new Date(t.at))}</span>
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
function freshestPrice(c: WatchCoinDay): { usd: number; at: string; from: "stored" | "last trade" } | null {
  const t = c.trades.find((x) => x.usd !== null && x.qty > 0);
  const trade = t ? { usd: t.usd! / t.qty, at: t.at, from: "last trade" as const } : null;
  const stored = c.nowUsd !== null && c.nowAt ? { usd: c.nowUsd, at: c.nowAt, from: "stored" as const } : null;
  if (!trade) return stored;
  if (!stored) return trade;
  return Date.parse(trade.at) > Date.parse(stored.at) ? trade : stored;
}

/** One coin's row, and its trades underneath when opened. */
function CoinRows({ c, isNew, showNames, serverNowSec }: { c: WatchCoinDay; isNew: boolean; showNames: boolean; serverNowSec: number }) {
  const [open, setOpen] = useState(false);
  const closed = soldOut(c);
  const price = freshestPrice(c);
  const stale = price !== null && serverNowSec * 1000 - Date.parse(price.at) > STALE_PRICE_MS;
  const priceNote = price ? `Price ${formatPrice(price.usd)} as of ${TIME.format(new Date(price.at))} (${price.from === "last trade" ? "their last trade" : "last price refresh"})${stale ? " — stale" : ""}` : "";
  const holdingUsd = price !== null ? c.holdingQty * price.usd : null;
  const sinceEntry = c.avgEntryUsd && price !== null && !closed ? ((price.usd - c.avgEntryUsd) / c.avgEntryUsd) * 100 : null;
  const cols = showNames ? 8 : 7;
  return (
    <>
      <tr className={trClass}>
        {showNames && (
          <td className={tdClass}>
            {isNew && <span className="mr-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">new</span>}
            <Link href={`/wallet-watch/${c.influencerId}`} className="font-medium text-fg hover:underline">
              {c.influencerName}
            </Link>
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
            <LastTrade t={c.trades[0]} ticker={c.ticker} />
          </p>
        </td>
        <td className={`${tdClass} tabular-nums`}>
          <Amount payQty={c.boughtPay} usd={c.boughtUsd} ticker={c.payTicker} qty={c.boughtQty} tone="text-positive" />
          {c.avgEntryUsd !== null && <p className="text-xs text-fg-muted">avg entry {formatPrice(c.avgEntryUsd)}</p>}
        </td>
        <td className={`${tdClass} tabular-nums`}>
          <Amount payQty={c.soldPay} usd={c.soldUsd} ticker={c.payTicker} qty={c.soldQty} tone="text-negative" />
          {c.avgExitUsd !== null && <p className="text-xs text-fg-muted">avg exit {formatPrice(c.avgExitUsd)}</p>}
        </td>
        <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
          {closed ? (
            // "sold all" only when nothing's left; a crumb under $1 says so.
            <span className="text-fg-muted">{c.holdingQty <= 0 ? "sold all" : "dust left"}</span>
          ) : (
            <>
              {compactQty(c.holdingQty)}
              {holdingUsd !== null && (
                <p className={`text-xs ${stale ? "text-warning" : "text-fg-muted"}`} title={priceNote}>
                  {formatUsd(holdingUsd)}
                  {stale && " ⚠"}
                </p>
              )}
            </>
          )}
        </td>
        <td className={`${tdClass} tabular-nums`}>
          {c.realizedUsd !== null ? (
            <span className={c.realizedUsd >= 0 ? "text-positive" : "text-negative"} title="Result of the part bought and sold today">
              {formatUsdSigned(c.realizedUsd)}
              {c.realizedPct !== null && <span className="block text-xs">{formatPercent(c.realizedPct)} on what was sold</span>}
              {/* Still holding the rest: how that part is doing (what KOLScan's ROI also counts). */}
              {sinceEntry !== null && (
                <span className={`block text-xs ${stale ? "text-warning" : sinceEntry >= 0 ? "text-positive" : "text-negative"}`} title={`${priceNote} vs average entry`}>
                  rest {formatPercent(sinceEntry)} since entry
                </span>
              )}
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
        <tr className="border-b border-border/60">
          <td colSpan={cols} className="px-3 pb-3">
            <ul className="space-y-0.5 border-l border-border/60 pl-3 text-xs">
              {c.trades.map((t) => (
                <li key={`${t.txId}|${t.side}`} className="flex flex-wrap justify-between gap-x-3">
                  <span>
                    <span className={sideTone(t)}>{SIDE[t.side]}</span> {tradeText(t, c.ticker)}
                    {t.usd !== null && <span className="text-fg-muted"> ({formatUsd(t.usd)}{t.qty > 0 ? ` · ${formatPrice(t.usd / t.qty)} each` : ""})</span>}
                  </span>
                  <span className="text-fg-muted">
                    {TIME.format(new Date(t.at))}
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

/** A trader's sold-out coins on one row: how many, totals, net result
 * and the tickers colored by result — their coin rows behind a toggle. */
function TraderGroup({ coins, latest, showNames, serverNowSec }: { coins: WatchCoinDay[]; latest: number; showNames: boolean; serverNowSec: number }) {
  const [open, setOpen] = useState(false);
  const first = coins[0];
  const sum = (f: (c: WatchCoinDay) => number | null) => coins.reduce((s, c) => s + (f(c) ?? 0), 0);
  const realized = sum((c) => c.realizedUsd);
  const lastAt = coins.map((c) => c.lastAt).sort().at(-1)!;
  const isNew = coins.some((c) => Date.parse(c.firstCheckedAt) >= latest);
  const byResult = [...coins].sort((a, b) => Math.abs(b.realizedUsd ?? 0) - Math.abs(a.realizedUsd ?? 0));
  return (
    <>
      <tr className={`${trClass} cursor-pointer`} onClick={() => setOpen((o) => !o)}>
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
          <span className="font-semibold text-fg">{coins.length} coins sold out today</span>
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
        <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>sold all</td>
        <td className={`${tdClass} tabular-nums`}>
          <span className={realized >= 0 ? "text-positive" : "text-negative"} title="Net result of what was bought and sold today">
            {formatUsdSigned(realized)}
          </span>
          <span className="block text-xs text-fg-muted">net, sold today</span>
        </td>
        <td className={`${tdClass} text-right`}>
          <span className="whitespace-nowrap text-xs text-fg-muted">
            <AgeText at={lastAt} serverNowSec={serverNowSec} /> {open ? "▴" : "▾"}
          </span>
        </td>
      </tr>
      {open && coins.map((c) => <CoinRows key={c.assetKey} c={c} isNew={Date.parse(c.firstCheckedAt) >= latest} showNames={showNames} serverNowSec={serverNowSec} />)}
    </>
  );
}

/** The coins as a sortable table (site convention: SortableHeader +
 * usePersistedState), newest activity first by default. */
function CoinTable({ coins, latest, showNames, serverNowSec }: { coins: WatchCoinDay[]; latest: number; showNames: boolean; serverNowSec: number }) {
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
    <div className="mt-1 max-h-[34rem] overflow-auto overscroll-contain">
      <table className={tableClass}>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className={theadRowClass}>
            {showNames && head("Trader", "trader")}
            {head("Coin", "coin")}
            {head("Bought", "bought")}
            {head("Sold", "sold")}
            <th className={`${thClass} ${hideOnMobileClass}`}>Holding</th>
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
  );
}

/**
 * Wallet Watch's activity since the morning read, per coin (like a trading
 * app's token cards), from the activity check and live updates (phases 4–5).
 * Cash coins (SOL, USDC, ETH) appear only as what trades were paid with.
 */
export function DayActivity({
  coins: serverCoins,
  checkedAt: serverCheckedAt,
  issues: serverIssues,
  liveIds = [],
  influencerIds,
  serverNowSec,
  showNames = true,
  showButton = true,
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
  /** False where the panel's header already has the button (Dashboard). */
  showButton?: boolean;
}) {
  const live = liveIds.some((id) => influencerIds.includes(id));
  const fresh = useLiveDay(influencerIds, live, serverCoins);
  const shown = new Set(influencerIds);
  const coins = fresh ? fresh.coins.filter((c) => shown.has(c.influencerId)) : serverCoins;
  const issues = fresh ? fresh.issues.filter((i) => shown.has(i.influencerId)) : serverIssues;
  const checkedAt = fresh ? (influencerIds.map((id) => fresh.checkedAt[id]).filter(Boolean).sort().at(-1) ?? serverCheckedAt) : serverCheckedAt;
  // Found by the latest check (the ones before it were already there).
  const latest = checkedAt ? Date.parse(checkedAt) - 60_000 : Infinity;

  return (
    <div className="mb-4 rounded-lg border border-border/60 bg-surface-raised/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold text-fg">Since this morning&apos;s read</span>
          {live && (
            <span className="ml-1.5 rounded bg-positive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-positive" title="Trades appear here by themselves within about a minute (Helius webhook).">
              live
            </span>
          )}
          <span className="text-xs text-fg-muted">
            {" · "}
            {checkedAt ? <AgeText at={checkedAt} serverNowSec={serverNowSec} prefix="checked " /> : "not checked yet"}
          </span>
        </p>
        {showButton && <ActivityCheckButton influencerIds={influencerIds} />}
      </div>
      {coins.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">{checkedAt || live ? "No trades since this morning's read." : "Refresh activity to see what they've done since this morning's read."}</p>
      ) : (
        <CoinTable coins={coins} latest={latest} showNames={showNames} serverNowSec={serverNowSec} />
      )}
      {issues.length > 0 && (
        <p className="mt-1 text-xs text-fg-muted" title={issues.map((i) => `${i.address.slice(0, 8)}…: ${i.status}`).join("\n")}>
          {issues.length} address{issues.length === 1 ? "" : "es"} not fully checked (hover for why) — this morning&apos;s read covers them.
        </p>
      )}
      <p className="mt-1 text-[11px] text-fg-muted/80">Per coin since this morning&apos;s read — click a row&apos;s time for its trades. Results count what was bought and sold today; a trim of an earlier position shows its share.</p>
    </div>
  );
}

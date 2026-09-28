"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { WatchCoinDay, WatchDayActivity } from "@/lib/watchQuery";
import type { CoinTrade } from "@/lib/watchActivity";
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

/** One coin's row, and its trades underneath when opened. */
function CoinRows({ c, isNew, showNames, serverNowSec }: { c: WatchCoinDay; isNew: boolean; showNames: boolean; serverNowSec: number }) {
  const [open, setOpen] = useState(false);
  const closed = c.holdingQty <= 0 && c.sells > 0;
  const holdingUsd = c.nowUsd !== null ? c.holdingQty * c.nowUsd : null;
  const sinceEntry = c.avgEntryUsd && c.nowUsd !== null && !closed ? ((c.nowUsd - c.avgEntryUsd) / c.avgEntryUsd) * 100 : null;
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
            <span className={sideTone(c.trades[0])}>{SIDE[c.trades[0].side]}</span> <span className="text-fg">{tradeText(c.trades[0], c.ticker)}</span>
            {c.trades[0].usd !== null && <span className="text-fg-muted"> ({formatUsd(c.trades[0].usd)})</span>}
            <span className="text-fg-muted"> · {TIME.format(new Date(c.trades[0].at))}</span>
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
            <span className="text-fg-muted">sold all</span>
          ) : (
            <>
              {compactQty(c.holdingQty)}
              {holdingUsd !== null && <p className="text-xs text-fg-muted">{formatUsd(holdingUsd)}</p>}
            </>
          )}
        </td>
        <td className={`${tdClass} tabular-nums`}>
          {c.realizedUsd !== null ? (
            <span className={c.realizedUsd >= 0 ? "text-positive" : "text-negative"} title="Result of what was bought and sold today">
              {formatUsdSigned(c.realizedUsd)}
              {c.realizedPct !== null && <span className="block text-xs">{formatPercent(c.realizedPct)}</span>}
            </span>
          ) : c.soldShareOfPosition !== null ? (
            <span className="text-negative">sold {Math.round(c.soldShareOfPosition * 100)}% of position</span>
          ) : (
            <span className="text-fg-muted">
              open
              {sinceEntry !== null && (
                <span className={`block text-xs ${sinceEntry >= 0 ? "text-positive" : "text-negative"}`} title={`Now ${c.nowUsd !== null ? formatPrice(c.nowUsd) : "—"} vs average entry`}>
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
  return (
    <div className="mt-1 overflow-x-auto">
      <table className={tableClass}>
        <thead>
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
          {sorted.map((c) => (
            <CoinRows key={`${c.influencerId}|${c.assetKey}`} c={c} isNew={Date.parse(c.firstCheckedAt) >= latest} showNames={showNames} serverNowSec={serverNowSec} />
          ))}
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

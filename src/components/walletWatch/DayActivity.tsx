"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { WatchCoinDay, WatchDayActivity } from "@/lib/watchQuery";
import { ACTIVITY_CHANNEL, ACTIVITY_EVENT, LIVE_REFETCH_MS } from "@/lib/liveChannel";
import { browserSupabase } from "@/lib/supabaseBrowser";
import { formatPercent, formatQty, formatUsd, formatUsdSigned } from "@/lib/format";
import { AgeText } from "@/components/AgeText";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/CopyButton";

/** How long a round trip lasted: "9m", "3h 20m". */
function heldFor(from: string, to: string): string {
  const min = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

/**
 * Live updates (phase 5): when any shown influencer is live, listen for the
 * server's "new activity" broadcast and fetch just these lines — at most once
 * a minute, and only while the tab is visible (a hidden tab catches up once
 * when shown). Nothing polls; without live influencers nothing listens.
 */
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
    const onVisible = () => {
      if (document.visibilityState === "visible" && pending) schedule();
    };
    const supabase = browserSupabase();
    const channel = supabase.channel(ACTIVITY_CHANNEL).on("broadcast", { event: ACTIVITY_EVENT }, schedule).subscribe();
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

const qty = (n: number) => formatQty(n);
const pay = (n: number | null, ticker: string | null) => (n !== null && ticker ? `${n < 1 ? n.toFixed(3) : n.toFixed(2)} ${ticker}` : null);
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** One coin's day: totals like a trading app's token card, and its trades
 * behind a toggle (owner 2026-09-28: match KOLScan's buys and sells). */
function CoinRow({ c, isNew, showNames, serverNowSec }: { c: WatchCoinDay; isNew: boolean; showNames: boolean; serverNowSec: number }) {
  const [open, setOpen] = useState(false);
  const closed = c.holdingQty <= 0 && c.sells > 0;
  const result = c.realizedUsd;
  const holdingUsd = c.nowUsd !== null ? c.holdingQty * c.nowUsd : null;
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="min-w-0">
          {isNew && <span className="mr-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">new</span>}
          {showNames && (
            <Link href={`/wallet-watch/${c.influencerId}`} className="font-medium text-fg hover:underline">
              {c.influencerName}
            </Link>
          )}{" "}
          <span className="font-semibold text-fg">{c.ticker}</span>
          {c.contract && (
            <span className="ml-1 inline-flex align-middle">
              <CopyButton value={c.contract} label={`Copy ${c.ticker} contract`} title={`Copy ${c.ticker}'s contract${c.contractChain ? ` (${c.contractChain})` : ""}: ${c.contract}`} />
            </span>
          )}
          <span className="text-xs text-fg-muted">
            {" "}
            · {c.buys} buy{c.buys === 1 ? "" : "s"}, {c.sells} sell{c.sells === 1 ? "" : "s"}
            {c.buys > 0 && <> · bought {pay(c.boughtPay, c.payTicker) ?? (c.boughtUsd !== null ? formatUsd(c.boughtUsd) : qty(c.boughtQty))}</>}
            {c.sells > 0 && <> · sold {pay(c.soldPay, c.payTicker) ?? (c.soldUsd !== null ? formatUsd(c.soldUsd) : qty(c.soldQty))}</>}
            {" · "}
            {closed ? "sold all" : `holding ${qty(c.holdingQty)}${holdingUsd !== null ? ` (${formatUsd(holdingUsd)})` : ""}`}
            {c.soldFromEarlier && " · incl. earlier holdings"}
            {c.trades.length > 1 && <> · over {heldFor(c.firstAt, c.lastAt)}</>}
          </span>
        </span>
        <span className="flex items-baseline gap-3 tabular-nums">
          {result !== null ? (
            <span className={result >= 0 ? "text-positive" : "text-negative"} title="Result of the part sold that was bought today">
              {formatUsdSigned(result)} {c.realizedPct !== null && <span className="text-xs">({formatPercent(c.realizedPct)})</span>}
            </span>
          ) : (
            <span className="text-xs text-fg-muted">{c.sells === 0 ? "open" : "—"}</span>
          )}
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs text-fg-muted hover:text-fg">
            <AgeText at={c.lastAt} serverNowSec={serverNowSec} /> {open ? "▴" : "▾"}
          </button>
        </span>
      </div>
      {open && (
        <ul className="mt-1.5 space-y-0.5 border-l border-border/60 pl-3 text-xs">
          {c.trades.map((t) => (
            <li key={`${t.txId}|${t.side}`} className="flex flex-wrap justify-between gap-x-3">
              <span>
                <span className={t.side === "buy" || t.side === "received" ? "text-positive" : "text-negative"}>{t.side === "buy" ? "Buy" : t.side === "sell" ? "Sell" : t.side === "received" ? "Received" : "Sent"}</span>{" "}
                {t.side === "buy" && pay(t.payQty, t.payTicker) ? `${pay(t.payQty, t.payTicker)} → ${qty(t.qty)} ${c.ticker}` : t.side === "sell" && pay(t.payQty, t.payTicker) ? `${qty(t.qty)} ${c.ticker} → ${pay(t.payQty, t.payTicker)}` : `${qty(t.qty)} ${c.ticker}`}
                {t.usd !== null && <span className="text-fg-muted"> ({formatUsd(t.usd)})</span>}
              </span>
              <span className="text-fg-muted">
                {TIME.format(new Date(t.at))}
                {t.source === "webhook" && " · live"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
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
        <ul className="mt-1 divide-y divide-border/60">
          {coins.map((c) => (
            <CoinRow key={`${c.influencerId}|${c.assetKey}`} c={c} isNew={Date.parse(c.firstCheckedAt) >= latest} showNames={showNames} serverNowSec={serverNowSec} />
          ))}
        </ul>
      )}
      {issues.length > 0 && (
        <p className="mt-1 text-xs text-fg-muted" title={issues.map((i) => `${i.address.slice(0, 8)}…: ${i.status}`).join("\n")}>
          {issues.length} address{issues.length === 1 ? "" : "es"} not fully checked (hover for why) — this morning&apos;s read covers them.
        </p>
      )}
      <p className="mt-1 text-[11px] text-fg-muted/80">Per coin since this morning&apos;s read — click a row&apos;s time for its trades. Results count only what was bought and sold today.</p>
    </div>
  );
}

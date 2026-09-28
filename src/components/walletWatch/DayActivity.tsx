"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { WatchDayLine } from "@/lib/watchQuery";
import { CASH_KEYS } from "@/lib/watchActivity";
import { formatPercent, formatPrice, formatQty, formatUsdSigned } from "@/lib/format";
import { AgeText } from "@/components/AgeText";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/CopyButton";
import { NowPrice } from "./ActivityFeed";

/** Verbs by how it happened: a trade, or a plain transfer (never called a
 * buy or sale), or a token out we can't tell apart (watchActivity.ts). */
function verb(l: WatchDayLine): string {
  if (l.kind === "roundtrip") return "bought and sold";
  // The coin trades are paid in: its balance moving is cash, not a decision.
  if (l.priceKey && CASH_KEYS.has(l.priceKey)) return l.qtyAfter > l.qtyBefore ? "cash up" : "cash down";
  if (l.via === "unclear") return l.kind === "exited" ? "sent or sold all" : "sent or sold";
  const transfer = l.via === "transfer";
  switch (l.kind) {
    case "new":
      return transfer ? "received" : "bought";
    case "added":
      return transfer ? "received more" : "added";
    case "trimmed":
      return transfer ? "sent" : "trimmed";
    case "exited":
      return transfer ? "sent all" : "sold all";
  }
}

/** How long a round trip lasted: "9m", "3h 20m". */
function heldFor(from: string, to: string): string {
  const min = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
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

/**
 * Wallet Watch's activity check (docs/wallet-watch/PLAN.md, phase 4): what
 * the watched wallets did since this morning's read, from their
 * transactions, on demand (ActivityCheckButton).
 */
export function DayActivity({
  lines,
  checkedAt,
  issues,
  influencerIds,
  serverNowSec,
  showNames = true,
  showButton = true,
}: {
  lines: WatchDayLine[];
  /** The latest check of these influencers' addresses. */
  checkedAt: string | null;
  issues: { address: string; status: string }[];
  influencerIds: string[];
  serverNowSec: number;
  showNames?: boolean;
  /** False where the panel's header already has the button (Dashboard). */
  showButton?: boolean;
}) {
  // Found by the latest check (the ones before it were already there).
  const latest = checkedAt ? Date.parse(checkedAt) - 60_000 : Infinity;

  return (
    <div className="mb-4 rounded-lg border border-border/60 bg-surface-raised/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold text-fg">Since this morning&apos;s read</span>
          <span className="text-xs text-fg-muted">
            {" · "}
            {checkedAt ? <AgeText at={checkedAt} serverNowSec={serverNowSec} prefix="checked " /> : "not checked yet"}
          </span>
        </p>
        {showButton && <ActivityCheckButton influencerIds={influencerIds} />}
      </div>
      {lines.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">{checkedAt ? "No buys or sells since this morning's read." : "Refresh activity to see what they've done since this morning's read."}</p>
      ) : (
        <ul className="mt-1 divide-y divide-border/60">
          {lines.map((l) => {
            const trip = l.roundTrip;
            const buying = trip ? trip.pnlUsd >= 0 : l.qtyAfter > l.qtyBefore;
            const isNew = Date.parse(l.firstCheckedAt) >= latest;
            return (
              <li key={`${l.influencerId}|${l.assetKey}|${l.kind}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
                <span className="min-w-0">
                  {isNew && <span className="mr-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">new</span>}
                  {showNames && (
                    <Link href={`/wallet-watch/${l.influencerId}`} className="font-medium text-fg hover:underline">
                      {l.influencerName}
                    </Link>
                  )}{" "}
                  <span className={buying ? "text-positive" : "text-negative"}>{verb(l)}</span>{" "}
                  <span className="text-fg">
                    {formatQty(trip ? trip.qty : Math.abs(l.qtyAfter - l.qtyBefore))} {l.ticker}
                  </span>
                  {l.contract && (
                    <span className="ml-1 inline-flex align-middle">
                      <CopyButton value={l.contract} label={`Copy ${l.ticker} contract`} title={`Copy ${l.ticker}'s contract${l.contractChain ? ` (${l.contractChain})` : ""}: ${l.contract}`} />
                    </span>
                  )}
                  {!trip && l.priceKey && CASH_KEYS.has(l.priceKey) && (
                    <span className="text-xs text-fg-muted"> · {l.qtyAfter > l.qtyBefore ? "from sales and transfers in" : "spent on buys, fees and transfers out"}</span>
                  )}
                  {trip && (
                    <span className="text-xs text-fg-muted">
                      {" "}
                      within {heldFor(trip.firstBuyAt, trip.lastSellAt)} · paid {formatPrice(trip.buyPrice)} → sold at {formatPrice(trip.sellPrice)}{" "}
                      <span className={trip.pnlPct >= 0 ? "text-positive" : "text-negative"}>({formatPercent(trip.pnlPct)})</span>
                    </span>
                  )}
                  {!trip && l.tradePrice !== null && !(l.priceKey && CASH_KEYS.has(l.priceKey)) && <span className="text-xs text-fg-muted"> at {formatPrice(l.tradePrice)}</span>}
                  {!trip && l.tradePrice !== null && l.tradePrice > 0 && l.nowUsd !== null && l.nowAt !== null && Date.parse(l.nowAt) > Date.parse(l.lastAt) && (
                    <NowPrice nowUsd={l.nowUsd} nowAt={l.nowAt} movePrice={l.tradePrice} serverNowSec={serverNowSec} />
                  )}
                </span>
                <span className="flex items-baseline gap-3 tabular-nums">
                  <span className={buying ? "text-positive" : "text-negative"}>{formatUsdSigned(l.usdDelta)}</span>
                  <span className="text-xs text-fg-muted">
                    <AgeText at={l.lastAt} serverNowSec={serverNowSec} />
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {issues.length > 0 && (
        <p className="mt-1 text-xs text-fg-muted" title={issues.map((i) => `${i.address.slice(0, 8)}…: ${i.status}`).join("\n")}>
          {issues.length} address{issues.length === 1 ? "" : "es"} not fully checked (hover for why) — this morning&apos;s read covers them.
        </p>
      )}
      <p className="mt-1 text-[11px] text-fg-muted/80">From transactions: trades priced by their SOL, ETH or stablecoin side; sized at today&apos;s price. Tomorrow&apos;s read confirms them.</p>
    </div>
  );
}

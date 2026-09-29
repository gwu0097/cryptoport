"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { AgeText } from "@/components/AgeText";
import { CoinTable } from "./DayActivity";
import { HISTORY_DAYS, type HistoryDays } from "@/lib/watchHistory";
import type { RecentTrades } from "@/lib/watchHistoryLoad";

/** Recent trades (watchHistoryLoad.ts): the influencer's EVM trades over the
 * last 7 or 30 days, read on demand — the day's activity table over a longer
 * window. Nothing is read until a button is pressed. */
export function RecentTradesPanel({ influencerId, evmAddresses, serverNowSec }: { influencerId: string; evmAddresses: number; serverNowSec: number }) {
  const [days, setDays] = useState<HistoryDays | null>(null);
  const [loading, setLoading] = useState<HistoryDays | null>(null);
  const [result, setResult] = useState<{ trades: RecentTrades; fetchedAtMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(d: HistoryDays) {
    setLoading(d);
    setError(null);
    try {
      const res = await fetch("/api/wallet-watch/history", { method: "POST", body: JSON.stringify({ influencerId, days: d }) });
      const body = (await res.json()) as { trades: RecentTrades; fetchedAtMs: number } | { error: string };
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
      setResult(body);
      setDays(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  const t = result?.trades;
  return (
    <Panel
      title="Recent trades"
      description="Their EVM wallets' trades over the last days, per coin — read from each chain's transfers once, then kept: later loads read only what's new (Solana addresses: see the trading record)."
    >
      <div className="flex flex-wrap items-center gap-2">
        {HISTORY_DAYS.map((d) => (
          <Button key={d} type="button" size="sm" variant={days === d ? "primary" : "secondary"} disabled={loading !== null || evmAddresses === 0} onClick={() => load(d)}>
            <History className="size-3.5" aria-hidden="true" />
            {loading === d ? `Reading ${d} days of transfers…` : `Last ${d} days`}
          </Button>
        ))}
        {loading !== null && <span className="text-xs text-fg-muted">each wallet, each chain — up to half a minute</span>}
        {evmAddresses === 0 && <span className="text-xs text-fg-muted">No EVM addresses on this influencer.</span>}
      </div>
      {error && <p className="mt-2 text-sm text-warning">{error}</p>}
      {t && (
        <div className="mt-3">
          <p className="text-xs text-fg-muted">
            Last {t.days} days · {t.chains === 0 ? "from stored history, nothing new to read" : `${t.chains} chain read${t.chains === 1 ? "" : "s"} for what wasn't stored yet`} · <AgeText at={new Date(result!.fetchedAtMs).toISOString()} serverNowSec={serverNowSec} />
            {t.sizedToday > 0 && <span className="text-warning"> · {t.sizedToday} trade{t.sizedToday === 1 ? "" : "s"} sized at today&apos;s price (no stored price for that day, or a coin-for-coin swap)</span>}
          </p>
          {t.coins.length === 0 ? (
            <p className="mt-2 text-sm text-fg-muted">No trades in the last {t.days} days.</p>
          ) : (
            <CoinTable coins={t.coins} latest={Infinity} showNames={false} serverNowSec={serverNowSec} period={`in ${t.days} days`} />
          )}
          {t.partial.length > 0 && <p className="mt-1 text-xs text-warning">Partial — only the newest transfers were read on: {t.partial.join(", ")}.</p>}
          {t.failed.length > 0 && <p className="mt-1 text-xs text-warning">Not read: {t.failed.join("; ")}</p>}
          <p className="mt-1 text-[11px] text-fg-muted/80">Swaps are sized at the paying coin&apos;s close that day; a coin-for-coin swap at the coins&apos; current prices. Holding and results start from what each coin held {t.days} days ago, worked back from the last read.</p>
        </div>
      )}
    </Panel>
  );
}

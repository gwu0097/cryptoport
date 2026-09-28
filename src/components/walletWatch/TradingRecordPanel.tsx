"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LineChart } from "lucide-react";
import type { CoinBrief, MonthCoins, TradingSummary } from "@/lib/tradingRecord";
import { formatCompactUsd, formatPercent } from "@/lib/format";
import { AgeText } from "@/components/AgeText";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { CopyButton } from "@/components/CopyButton";

const signedCompact = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${formatCompactUsd(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? "text-positive" : v < 0 ? "text-negative" : "text-fg");
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function hold(secs: number | null): string {
  if (secs === null) return "—";
  const h = secs / 3600;
  return h < 1 ? `${Math.round(secs / 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

/** The 12 months ending with `today`'s, oldest first, with zero where nothing traded. */
function lastTwelve(months: TradingSummary["months"], today: string) {
  const by = new Map(months.map((m) => [m.month, m]));
  const out: { month: string; realizedUsd: number; trades: number }[] = [];
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    out.push(by.get(m) ?? { month: m, realizedUsd: 0, trades: 0 });
  }
  return out;
}

function CoinRow({ c }: { c: CoinBrief }) {
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="truncate font-medium text-fg">{c.symbol}</span>
        <CopyButton value={c.mint} label={`Copy ${c.symbol} contract`} title={`Copy ${c.symbol}'s contract: ${c.mint}`} />
      </span>
      <span className="shrink-0 tabular-nums">
        <span className="text-fg-muted" title="What was put into the position">
          {c.investedUsd !== null ? formatCompactUsd(c.investedUsd) : "—"} in →{" "}
        </span>
        <span className={tone(c.pnlUsd)}>{signedCompact(c.pnlUsd)}</span>
        {c.roiPct !== null && <span className="text-fg-muted"> ({formatPercent(c.roiPct)})</span>}
      </span>
    </li>
  );
}

/** The coins sold in a month (hover or tap its bar): how many, how many
 * won, the biggest gains and losses. A coin counts in the month it was last
 * sold, so these needn't add up exactly to the bar (daily figures). */
function MonthDetail({ month, realizedUsd, coins, hasCoinList }: { month: string; realizedUsd: number; coins: MonthCoins | undefined; hasCoinList: boolean }) {
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  return (
    <div className="mt-3 rounded-lg border border-border/60 p-3">
      <p className="text-sm">
        <span className="font-semibold text-fg">{label}</span> <span className={tone(realizedUsd)}>{signedCompact(realizedUsd)}</span>
        {coins && (
          <span className="text-xs text-fg-muted">
            {" "}
            · {coins.count.toLocaleString()} coins sold · {coins.count > 0 ? Math.round((coins.wins / coins.count) * 100) : 0}% won
          </span>
        )}
      </p>
      {!hasCoinList ? (
        <p className="mt-1 text-xs text-fg-muted">Refresh the record to list each month&apos;s coins.</p>
      ) : !coins ? (
        <p className="mt-1 text-xs text-fg-muted">No coins sold this month.</p>
      ) : (
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Biggest gains</p>
            {coins.top.length === 0 ? <p className="text-xs text-fg-muted">None</p> : <ul className="space-y-1">{coins.top.map((c) => <CoinRow key={c.mint} c={c} />)}</ul>}
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Biggest losses</p>
            {coins.bottom.length === 0 ? <p className="text-xs text-fg-muted">None</p> : <ul className="space-y-1">{coins.bottom.map((c) => <CoinRow key={c.mint} c={c} />)}</ul>}
          </div>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, caption, valueClass }: { label: string; value: string; caption?: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${valueClass ?? "text-fg"}`}>{value}</p>
      {caption && <p className="mt-0.5 text-xs text-fg-muted">{caption}</p>}
    </div>
  );
}

/**
 * An influencer's trading record (tradingRecord.ts), from Solana Tracker in
 * USD: all time, the past year by month (profitable all year, or one hot
 * streak?), and the last 90/30 days. Loaded only when asked (2 requests per
 * Solana address), shared by everyone watching it. Observations, not advice.
 */
export function TradingRecordPanel({
  influencerId,
  summary,
  loadedAt,
  solanaAddresses,
  otherAddresses,
  errors,
  today,
  serverNowSec,
}: {
  influencerId: string;
  summary: TradingSummary | null;
  loadedAt: string | null;
  solanaAddresses: number;
  otherAddresses: number;
  errors: string[];
  today: string;
  serverNowSec: number;
}) {
  const router = useRouter();
  const [month, setMonth] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wallet-watch/trading-record", { method: "POST", body: JSON.stringify({ influencerId }) });
      const body = (await res.json()) as { outcomes?: { status: string; error?: string }[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      const failed = body.outcomes?.filter((o) => o.status === "error") ?? [];
      if (failed.length > 0) setError(failed.map((f) => f.error).join("; "));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  if (solanaAddresses === 0) {
    return (
      <Panel title="Trading record" className="mb-4">
        <p className="mt-1 text-sm text-fg-muted">Trading records cover Solana addresses for now — this influencer has none.</p>
      </Panel>
    );
  }

  const months = summary ? lastTwelve(summary.months, today) : [];
  const scale = Math.max(1, ...months.map((m) => Math.abs(m.realizedUsd)));
  const at = summary?.allTime;

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center justify-between gap-2">
          Trading record
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={load} title="Two Solana Tracker requests per Solana address (2,500 a month free); a record under an hour old is reused.">
            <LineChart className={`size-3.5 ${busy ? "animate-pulse" : ""}`} aria-hidden="true" />
            {busy ? "Loading…" : summary ? "Refresh record" : "Load trading record"}
          </Button>
        </span>
      }
      description={
        summary ? (
          <>
            Realized profit from their trades, in USD (Solana Tracker) · loaded <AgeText at={loadedAt} serverNowSec={serverNowSec} />
            {otherAddresses > 0 && ` · ${otherAddresses} non-Solana address${otherAddresses === 1 ? "" : "es"} not covered`}
          </>
        ) : (
          "Is this trader profitable all year, or on one hot streak? Load their record from Solana Tracker (2 requests per Solana address)."
        )
      }
      className="mb-4"
    >
      {(error || errors.length > 0) && <p className="mt-2 text-xs text-warning">{error ?? errors.join("; ")}</p>}
      {summary && at && (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="All time" value={signedCompact(at.totalUsd)} valueClass={tone(at.totalUsd)} caption={`${at.roiPct !== null ? `${formatPercent(at.roiPct)} on money put in` : ""}${at.since ? ` · since ${at.since.slice(0, 7)}` : ""}`} />
            <Figure label="Past 12 months (realized)" value={signedCompact(summary.yearUsd)} valueClass={tone(summary.yearUsd)} caption={`${summary.profitableMonths} of ${summary.activeMonths} active months profitable`} />
            <Figure label="Last 90 days" value={signedCompact(summary.last90Usd)} valueClass={tone(summary.last90Usd)} />
            <Figure label="Last 30 days" value={signedCompact(summary.last30Usd)} valueClass={tone(summary.last30Usd)} />
          </div>

          <div className="mt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Realized profit by month · hover or tap a month for its coins</p>
            <div className="overflow-x-auto">
              <div className="grid min-w-[36rem] grid-cols-12 gap-1.5">
                {months.map((m) => (
                  <button
                    type="button"
                    key={m.month}
                    onMouseEnter={() => setMonth(m.month)}
                    onFocus={() => setMonth(m.month)}
                    onClick={() => setMonth(m.month)}
                    aria-pressed={month === m.month}
                    className={`flex flex-col items-center rounded ${month === m.month ? "bg-surface-raised/60" : ""}`}
                  >
                    <span className={`text-[10px] tabular-nums ${tone(m.realizedUsd)}`}>{m.trades > 0 ? signedCompact(m.realizedUsd) : "—"}</span>
                    <div className="relative mt-1 h-24 w-full rounded bg-surface-raised">
                      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                      {m.realizedUsd !== 0 && (
                        <div
                          className={`absolute inset-x-1 rounded-sm ${m.realizedUsd > 0 ? "bottom-1/2 bg-positive/70" : "top-1/2 bg-negative/70"}`}
                          style={{ height: `${Math.max(2, (Math.abs(m.realizedUsd) / scale) * 50)}%` }}
                        />
                      )}
                    </div>
                    <span className="mt-1 text-[10px] text-fg-muted">{MONTH.format(new Date(`${m.month}-01T00:00:00Z`))}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {month && <MonthDetail month={month} realizedUsd={months.find((m) => m.month === month)?.realizedUsd ?? 0} coins={summary.monthCoins[month]} hasCoinList={Object.keys(summary.monthCoins).length > 0} />}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Win rate (all time)" value={at.winRatePct !== null ? `${at.winRatePct.toFixed(1)}%` : "—"} caption={`${at.wins.toLocaleString()} of ${at.closed.toLocaleString()} closed coins · holds ${hold(at.avgHoldSecs)} on average`} />
            <Figure
              label="Best month's share of the year"
              value={summary.bestMonthShare !== null ? `${Math.round(summary.bestMonthShare * 100)}%` : "—"}
              caption={summary.bestMonthShare === null ? "The year isn't up" : summary.bestMonthShare > 0.5 ? "Most of the year's profit came from one month" : "Spread across the year"}
            />
            <Figure
              label="Best day"
              value={summary.bestDay ? signedCompact(summary.bestDay.realizedUsd) : "—"}
              valueClass={summary.bestDay ? tone(summary.bestDay.realizedUsd) : undefined}
              caption={summary.bestDay ? `${summary.bestDay.date}${summary.bestDayShare !== null ? ` · ${Math.round(summary.bestDayShare * 100)}% of the year` : ""}` : undefined}
            />
            <Figure
              label="Biggest drop from a peak"
              value={summary.drawdownPct !== null ? `−${summary.drawdownPct.toFixed(0)}%` : "—"}
              valueClass={summary.drawdownPct !== null ? "text-negative" : undefined}
              caption={summary.drawdownUsd !== null ? `${formatCompactUsd(summary.drawdownUsd)} over the year` : summary.addresses > 1 ? "Not combined across addresses" : undefined}
            />
          </div>

          {summary.distribution.length > 0 && (
            <p className="mt-3 text-xs text-fg-muted">
              Closed coins by return:{" "}
              {summary.distribution.map((d, i) => (
                <span key={d.range}>
                  {i > 0 && " · "}
                  {d.range} <span className="text-fg">{d.count.toLocaleString()}</span>
                </span>
              ))}
            </p>
          )}
          <p className="mt-1 text-[11px] text-fg-muted/80">Observations, not advice. Unrealized profit is what their unsold coins would add at today&apos;s prices.</p>
        </>
      )}
    </Panel>
  );
}

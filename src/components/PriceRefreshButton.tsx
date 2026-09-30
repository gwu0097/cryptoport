"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatStaleness } from "@/lib/format";
import type { PriceRefreshPhases, PriceRefreshState } from "@/lib/queries";
import { type JobStartResult } from "@/lib/jobStatus";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";
import { usePageRefreshes } from "./jobs/JobPoller";

// One lane per price source in the pricing pass (refreshAssetPrices).
const PHASE_LABELS: Record<string, string> = {
  coingecko: "CoinGecko",
  jupiter: "Jupiter",
  hyperliquid: "Hyperliquid",
  coinbase: "Coinbase",
  lighter: "Lighter",
  aster: "Aster",
};

// Fixed order (not object insertion order, which JSONB round-tripping
// doesn't guarantee).
const PHASE_ORDER = ["coingecko", "jupiter", "hyperliquid", "coinbase", "lighter", "aster"];

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One lane's status — "running…" while in flight, "2.1s" once done, "—"
 * if it errored (the real failure detail lives in the overall `status`
 * string, not surfaced per-lane here). */
function PhaseRow({ name, phase }: { name: string; phase: PriceRefreshPhases[string] }) {
  return (
    <span className="text-fg-muted">
      {PHASE_LABELS[name] ?? name}:{" "}
      {phase.status === "running" ? "running…" : phase.status === "error" ? "—" : formatMs(phase.ms ?? 0)}
    </span>
  );
}

/**
 * "Refresh prices" button + "Last priced: X ago" caption + per-lane
 * (CoinGecko/Jupiter/Hyperliquid/Coinbase) breakdown — identical on
 * Dashboard/Portfolio/Wallets/Assets/wallet-detail (5 call sites), same
 * "two is the threshold" extraction as SyncWalletButtons. Replaces the old
 * separate SubmitButton form + PriceRefreshCaption pair: this app's price
 * refresh is a job exactly like a wallet sync now (see
 * priceRefreshJob.ts claimPriceRefresh's compare-and-set), so it gets the same
 * useJob/JobButton lock-for-the-real-duration treatment.
 *
 * The phase breakdown keeps its original reasoning for only showing once
 * *this* mounted instance has actually observed a refresh happen (via
 * `busy`, not the raw `refreshing` status prop) — a fresh page load or
 * navigation starts with it hidden rather than resurrecting some earlier
 * refresh's now-irrelevant timing, even though price_refresh_state.phases
 * itself is still sitting there server-side.
 */
export function PriceRefreshButton({ priceState, walletId, compact = false }: { priceState: PriceRefreshState; walletId?: string; compact?: boolean }) {
  const router = useRouter();
  const status = useJobStatus({ status: priceState.status, started_at: priceState.startedAt });
  // The click runs the refresh and waits for it (api/prices/refresh, ~3 s),
  // then refreshes the page once — no polling while it runs. A refresh
  // another tab started is still waited for by useJob's polling.
  const split = useRef<{ requestMs: number; serverMs: number | null; pageFrom: number } | null>(null);
  const refresh = async (): Promise<JobStartResult> => {
    const t0 = Date.now();
    const res = await fetch("/api/prices/refresh", { method: "POST", body: JSON.stringify({ walletId }) });
    const body = (await res.json().catch(() => ({}))) as { started?: boolean; reason?: string; error?: string; serverMs?: number };
    if (!res.ok) throw new Error(body.error ?? `Refresh failed (HTTP ${res.status})`);
    split.current = { requestMs: Date.now() - t0, serverMs: body.serverMs ?? null, pageFrom: Date.now() };
    if (body.started) router.refresh();
    return body.started ? { started: true } : { started: false, reason: body.reason ?? "A price refresh is already running." };
  };
  const { busy, submit: start, error } = useJob({ status, start: refresh });
  // Where a click's time went: from the click to the button unlocking, the
  // prices themselves (the slowest lane) and each page refresh after them.
  const refreshes = usePageRefreshes();
  const clickedAt = useRef<number | null>(null);
  const [timing, setTiming] = useState<{ totalMs: number; refreshes: number[]; requestMs: number | null; serverMs: number | null; pageMs: number | null } | null>(null);
  const submit = () => {
    clickedAt.current = Date.now();
    setTiming(null);
    start();
  };
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) wasBusy.current = true;
    else if (wasBusy.current && clickedAt.current !== null) {
      const since = clickedAt.current;
      const sp = split.current;
      setTiming({
        totalMs: Date.now() - since,
        refreshes: refreshes.filter((r) => r.at >= since).map((r) => r.ms),
        requestMs: sp?.requestMs ?? null,
        serverMs: sp?.serverMs ?? null,
        pageMs: sp ? Date.now() - sp.pageFrom : null,
      });
      split.current = null;
      wasBusy.current = false;
      clickedAt.current = null;
    }
  }, [busy, refreshes]);
  const pricesMs = priceState.phases ? Math.max(0, ...Object.values(priceState.phases).map((p) => p.ms ?? 0)) : null;

  const hasObservedRefresh = useRef(false);
  const [showPhases, setShowPhases] = useState(false);
  useEffect(() => {
    if (busy) {
      hasObservedRefresh.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowPhases(true);
    } else if (hasObservedRefresh.current) {
      setShowPhases(true);
    }
  }, [busy]);

  // Compact (the Dashboard's stat tile): the per-source times and the
  // click's total in one line (owner 2026-09-30: wanted them back), the
  // full breakdown in the tooltip.
  const phaseText = priceState.phases
    ? PHASE_ORDER.filter((name) => priceState.phases![name])
        .map((name) => {
          const p = priceState.phases![name];
          return `${PHASE_LABELS[name] ?? name}: ${p.status === "running" ? "running…" : p.status === "error" ? "—" : formatMs(p.ms ?? 0)}`;
        })
        .join(" · ")
    : "";
  const timingText = timing
    ? `Done in ${formatMs(timing.totalMs)}${timing.requestMs !== null ? ` · request ${formatMs(timing.requestMs)}` : ""}${pricesMs !== null ? ` · prices ${formatMs(pricesMs)}` : ""}${timing.pageMs !== null ? ` · page ${formatMs(timing.pageMs)}` : ""}`
    : "";
  const detailsTitle = [phaseText, timingText].filter(Boolean).join("\n");

  return (
    <div className="flex flex-col items-end gap-1" title={compact && detailsTitle ? detailsTitle : undefined}>
      <JobButton
        busy={busy}
        submit={submit}
        busyLabel={
          <>
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
            Refreshing…
          </>
        }
        variant="secondary"
        size="sm"
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Refresh prices
      </JobButton>
      {/* No plain "Refreshing…" caption while busy — the button's own
          busyLabel already says that; reported directly as redundant
          ("if the button already says refreshing doesn't need a status
          underneath it saying the same thing"). The phase breakdown right
          below isn't redundant, though — it's genuinely new information
          (which lane is running, how long each took) the button label
          can't show. */}
      {!busy && <PricedCaption priceState={priceState} />}
      {/* Compact (the stat tile): each source's time and the click's total in
          one short line; the full breakdown on hover. */}
      {compact && !busy && showPhases && phaseText && (
        // Wraps between items, never inside one (and never cut off).
        <p className="flex flex-wrap justify-end gap-x-1.5 text-right text-[11px] text-fg-muted/70">
          {[timing ? `Done in ${formatMs(timing.totalMs)}` : null, ...phaseText.split(" · ")]
            .filter((x): x is string => !!x)
            .map((x, i) => (
              <span key={x} className="whitespace-nowrap">
                {i > 0 && "· "}
                {x}
              </span>
            ))}
        </p>
      )}
      {!compact && showPhases && priceState.phases && (
        <p className="flex flex-wrap justify-end gap-x-2 text-[11px] text-fg-muted/70">
          {PHASE_ORDER.filter((name) => priceState.phases![name]).map((name) => (
            <PhaseRow key={name} name={name} phase={priceState.phases![name]} />
          ))}
        </p>
      )}
      {!compact && timing && !busy && (
        <p className="text-right text-[11px] text-fg-muted/70" title="From your click to the button unlocking: the price fetch itself, then each time the page reloaded its data.">
          Done in {formatMs(timing.totalMs)}
          {timing.requestMs !== null && ` · request ${formatMs(timing.requestMs)}${timing.serverMs !== null ? ` (server ${formatMs(timing.serverMs)})` : ""}`}
          {pricesMs !== null && ` · prices ${formatMs(pricesMs)}`}
          {timing.pageMs !== null && ` · page ${formatMs(timing.pageMs)}`}
          {timing.refreshes.length > 0 && ` · page refreshed ${timing.refreshes.length}× (${timing.refreshes.map(formatMs).join(", ")})`}
        </p>
      )}
      {error && <p className="max-w-xs text-right text-xs text-negative">{error}</p>}
    </div>
  );
}

/** "Priced 2m ago · 3 older than 1h" — when the user's held coins were
 * priced (lib/pricesAsOf.ts), with the lagging coins named on hover. Falls
 * back to the last full refresh before any coin has a price. */
function PricedCaption({ priceState }: { priceState: PriceRefreshState }) {
  const { newestAt, stale } = priceState.pricesAsOf;
  const at = newestAt ?? priceState.refreshedAt;
  return (
    <p className="text-xs text-fg-muted">
      {at ? `Priced ${formatStaleness(at)}` : "Not priced yet"}
      {stale.length > 0 && (
        <span
          className="text-warning"
          title={stale.map((s) => `${s.label}: ${formatStaleness(s.at)}`).join("\n")}
        >{` · ${stale.length} older than 1h`}</span>
      )}
    </p>
  );
}

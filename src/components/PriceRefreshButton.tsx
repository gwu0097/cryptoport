"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatStaleness } from "@/lib/format";
import type { PriceRefreshPhases, PriceRefreshState } from "@/lib/queries";
import { type JobStartResult } from "@/lib/jobStatus";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

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
 * refreshPricesAction's own compare-and-set claim), so it gets the same
 * useJob/JobButton lock-for-the-real-duration treatment.
 *
 * The phase breakdown keeps its original reasoning for only showing once
 * *this* mounted instance has actually observed a refresh happen (via
 * `busy`, not the raw `refreshing` status prop) — a fresh page load or
 * navigation starts with it hidden rather than resurrecting some earlier
 * refresh's now-irrelevant timing, even though price_refresh_state.phases
 * itself is still sitting there server-side.
 */
export function PriceRefreshButton({
  priceState,
  refresh,
}: {
  priceState: PriceRefreshState;
  refresh: () => Promise<JobStartResult>;
}) {
  const status = useJobStatus({ status: priceState.status, started_at: priceState.startedAt });
  const { busy, submit, error } = useJob({ status, start: refresh });

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

  return (
    <div className="flex flex-col items-end gap-1">
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
      {showPhases && priceState.phases && (
        <p className="flex flex-wrap justify-end gap-x-2 text-[11px] text-fg-muted/70">
          {PHASE_ORDER.filter((name) => priceState.phases![name]).map((name) => (
            <PhaseRow key={name} name={name} phase={priceState.phases![name]} />
          ))}
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

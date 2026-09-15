"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatStaleness } from "@/lib/format";
import type { PriceRefreshPhases, PriceRefreshState } from "@/lib/queries";
import { type JobStartResult } from "@/lib/jobStatus";
import { useJob } from "./jobs/useJob";
import { useJobStatus } from "./jobs/useJobStatus";
import { JobButton } from "./jobs/JobButton";

const PHASE_LABELS: Record<string, string> = {
  coingecko: "CoinGecko",
  coinbase: "Coinbase/Jupiter",
  evm: "EVM holdings",
};

// Fixed order (not object insertion order, which JSONB round-tripping
// doesn't guarantee) — matches the order refreshPrices actually starts
// these lanes in.
const PHASE_ORDER = ["coingecko", "coinbase", "evm"];

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
 * (CoinGecko/Coinbase-Jupiter/EVM holdings) breakdown — identical on
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
      <p className="text-xs text-fg-muted">
        {busy ? "Refreshing…" : `Last priced: ${formatStaleness(priceState.refreshedAt)}`}
      </p>
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

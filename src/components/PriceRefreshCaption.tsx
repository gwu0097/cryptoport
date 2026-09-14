"use client";

import { useEffect, useRef, useState } from "react";
import { formatStaleness } from "@/lib/format";
import type { PriceRefreshPhases, PriceRefreshState } from "@/lib/queries";
import { AutoRefreshWhileSyncing } from "./AutoRefreshWhileSyncing";

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
 * string above this, not per-lane). */
function PhaseRow({ name, phase }: { name: string; phase: PriceRefreshPhases[string] }) {
  return (
    <span className="text-fg-muted">
      {PHASE_LABELS[name] ?? name}:{" "}
      {phase.status === "running" ? "running…" : phase.status === "error" ? "—" : formatMs(phase.ms ?? 0)}
    </span>
  );
}

/**
 * The "Last priced: Xh ago" caption under the Refresh prices button —
 * identical on Dashboard/Portfolio/Wallets/Assets/wallet-detail (5 copies
 * before this was extracted, past this app's own "two is the threshold"
 * rule). refreshPricesAction now returns almost immediately and does the
 * real work in after() (same reasoning as syncWalletHoldings — a 30-second
 * awaited Server Action froze every other click app-wide until it
 * finished), so `status === "refreshing"` is a real in-flight state now,
 * not just a final outcome — shown here instead of a stale "Last priced"
 * time, with AutoRefreshWhileSyncing polling so the page picks up the
 * real result on its own once it lands.
 *
 * Also shows a per-lane breakdown (CoinGecko/Coinbase-Jupiter/EVM
 * holdings) — refreshPrices runs all three concurrently and writes each
 * one's status to price_refresh_state.phases as it actually finishes (see
 * that function's own doc comment), so this updates progressively while a
 * refresh is in flight. It's meant purely as "how long did the refresh I
 * just ran take" — a client component (not just a server-rendered prop),
 * specifically so a fresh page load/navigation starts with it hidden
 * rather than resurrecting some earlier refresh's now-irrelevant timing:
 * `hasObservedRefresh` only flips true once *this* mounted instance
 * actually sees status go to "refreshing" itself, so the breakdown shows
 * live while that's happening and stays as a record right after — but a
 * plain reload or switching pages starts over with it gone, even though
 * price_refresh_state.phases itself is still sitting there server-side.
 */
export function PriceRefreshCaption({ priceState }: { priceState: PriceRefreshState }) {
  const refreshing = priceState.status === "refreshing";
  const hasObservedRefresh = useRef(false);
  const [showPhases, setShowPhases] = useState(false);

  useEffect(() => {
    if (refreshing) {
      hasObservedRefresh.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowPhases(true);
    } else if (hasObservedRefresh.current) {
      setShowPhases(true);
    }
  }, [refreshing]);

  return (
    <>
      {/* 1.2s, not the 4s default — CoinGecko (the fastest lane) can finish
          in a few seconds; a 4s poll would only get one or two chances to
          ever catch a lane mid-flight, which read as "nothing updates
          live, they all just appear at once at the end" even though the
          writes themselves were happening progressively the whole time. */}
      <AutoRefreshWhileSyncing syncing={refreshing} pollMs={1200} />
      <p className="text-xs text-fg-muted">
        {refreshing ? "Refreshing…" : `Last priced: ${formatStaleness(priceState.refreshedAt)}`}
      </p>
      {showPhases && priceState.phases && (
        <p className="flex flex-wrap justify-end gap-x-2 text-[11px] text-fg-muted/70">
          {PHASE_ORDER.filter((name) => priceState.phases![name]).map((name) => (
            <PhaseRow key={name} name={name} phase={priceState.phases![name]} />
          ))}
        </p>
      )}
    </>
  );
}

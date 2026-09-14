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
 * refresh is in flight, then stays as a record of how long each lane took
 * once it's done — real requested behavior, not just a spinner.
 */
export function PriceRefreshCaption({ priceState }: { priceState: PriceRefreshState }) {
  const refreshing = priceState.status === "refreshing";
  return (
    <>
      <AutoRefreshWhileSyncing syncing={refreshing} />
      <p className="text-xs text-fg-muted">
        {refreshing ? "Refreshing…" : `Last priced: ${formatStaleness(priceState.refreshedAt)}`}
      </p>
      {priceState.phases && (
        <p className="flex flex-wrap justify-end gap-x-2 text-[11px] text-fg-muted/70">
          {PHASE_ORDER.filter((name) => priceState.phases![name]).map((name) => (
            <PhaseRow key={name} name={name} phase={priceState.phases![name]} />
          ))}
        </p>
      )}
    </>
  );
}

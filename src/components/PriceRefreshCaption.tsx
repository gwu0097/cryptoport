import { formatStaleness } from "@/lib/format";
import type { PriceRefreshState } from "@/lib/queries";
import { AutoRefreshWhileSyncing } from "./AutoRefreshWhileSyncing";

/**
 * The "Last priced: Xh ago" caption under the Refresh prices button —
 * identical on Dashboard/Portfolio/Wallets/Assets (4 copies before this
 * was extracted, past this app's own "two is the threshold" rule).
 * refreshPricesAction now returns almost immediately and does the real
 * work in after() (same reasoning as syncWalletHoldings — a 30-second
 * awaited Server Action froze every other click app-wide until it
 * finished), so `status === "refreshing"` is a real in-flight state now,
 * not just a final outcome — shown here instead of a stale "Last priced"
 * time, with AutoRefreshWhileSyncing polling so the page picks up the
 * real result on its own once it lands.
 */
export function PriceRefreshCaption({ priceState }: { priceState: PriceRefreshState }) {
  const refreshing = priceState.status === "refreshing";
  return (
    <>
      <AutoRefreshWhileSyncing syncing={refreshing} />
      <p className="text-xs text-fg-muted">
        {refreshing ? "Refreshing…" : `Last priced: ${formatStaleness(priceState.refreshedAt)}`}
      </p>
    </>
  );
}

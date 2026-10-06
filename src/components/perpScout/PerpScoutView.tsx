"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { CollapsiblePanel } from "@/components/ui/CollapsiblePanel";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Button } from "@/components/ui/Button";
import { AgeText } from "@/components/AgeText";
import type { PerpScoutData } from "@/lib/perpScoutScan";
import { EntriesTable } from "./EntriesTable";
import { TradersTable } from "./TradersTable";
import { shortAddress } from "./labels";

/** Perp Scout's two sections: the followed traders' open entries (with
 * Refresh prices, current mids swapped in without a scan) and the traders. */
export function PerpScoutView({ data, signedIn, serverNowSec }: { data: PerpScoutData; signedIn: boolean; serverNowSec: number }) {
  const [mids, setMids] = useState<{ at: number; mids: Record<string, number> } | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const traders = data.screen?.traders ?? [];
  const names = Object.fromEntries(traders.map((t) => [t.address, t.displayName ?? shortAddress(t.address)]));
  const entries = data.scan?.entries ?? [];

  async function refreshPrices() {
    setPricing(true);
    setPriceError(null);
    try {
      const res = await fetch("/api/perp-scout/prices", { method: "POST", cache: "no-store" });
      const body = (await res.json()) as { at?: number; mids?: Record<string, number>; error?: string };
      if (!res.ok || !body.mids || !body.at) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMids({ at: body.at, mids: body.mids });
    } catch (e) {
      setPriceError((e as Error).message);
    } finally {
      setPricing(false);
    }
  }

  const screen = data.screen;
  return (
    <div className="space-y-6">
      <Panel
        title={
          <span className="inline-flex items-center gap-1.5">
            Entries
            <InfoTooltip>
              Every open position of the followed traders. &quot;vs entry&quot; is how far price has moved since their average entry, in their direction: negative means they&apos;re down — the price now is better than theirs (below it on a long, above it on a short). &quot;First fill&quot; is the price of the order that opened the position, when it&apos;s within their latest 2,000 fills; &quot;over Nd&quot; means it was opened before those. Observations, not signals.
            </InfoTooltip>
          </span>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button variant="secondary" size="sm" disabled={pricing || !signedIn || entries.length === 0} onClick={refreshPrices} title={signedIn ? "Current prices from Hyperliquid (one call)" : "Sign in to refresh prices"}>
              {pricing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
              Refresh prices
            </Button>
            <span className="text-xs text-fg-muted">
              {priceError ? <span className="text-warning">{priceError}</span> : mids ? <AgeText at={mids.at} serverNowSec={serverNowSec} prefix="Prices " /> : data.scan ? <AgeText at={data.scan.scannedAt} serverNowSec={serverNowSec} prefix="Prices from the scan, " /> : null}
            </span>
          </div>
        }
      >
        {data.scan ? (
          <EntriesTable entries={entries} names={names} mids={mids?.mids ?? null} serverNowSec={serverNowSec} />
        ) : (
          <p className="text-sm text-fg-muted">{signedIn ? "Press Scan to find the traders and read their open positions." : "Log in and press Scan to find the traders and read their open positions."}</p>
        )}
      </Panel>

      {screen && (
        <CollapsiblePanel
          storageKey="cryptoport:perpScoutTradersOpen"
          density="normal"
          title={
            <span className="inline-flex items-center gap-1.5">
              Traders
              <InfoTooltip>
                From Hyperliquid&apos;s leaderboard ({screen.leaderboardCount.toLocaleString()} accounts): $50K–$20M account, all-time PnL ≥ $100K and ROI ≥ 50%, profitable over 30 days, monthly volume ≤ 60× account value ({screen.stage1Count.toLocaleString()} passed). {screen.reviewedCount} of those — the biggest earners and the best ROI — had their PnL history checked: ≥ 26 weeks, max drawdown no larger than typical equity, no more than 80% of profit in the best 4 weeks ({screen.passedCount} passed{screen.failedCount ? `, ${screen.failedCount} unreadable` : ""}). Ranked by yearly return ÷ max drawdown.
              </InfoTooltip>
            </span>
          }
          summary={<span className="text-xs text-fg-muted">{traders.length} followed</span>}
        >
          {traders.length ? <TradersTable traders={traders} books={data.scan?.books ?? []} /> : <p className="text-sm text-fg-muted">No trader passed the screen.</p>}
        </CollapsiblePanel>
      )}
    </div>
  );
}

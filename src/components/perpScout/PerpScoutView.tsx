"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { CollapsiblePanel } from "@/components/ui/CollapsiblePanel";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Button } from "@/components/ui/Button";
import { AgeText } from "@/components/AgeText";
import type { ScoutScan } from "@/lib/perpScoutScan";
import { FOLLOWED } from "@/lib/perpScout/followed";
import { EntriesTable } from "./EntriesTable";
import { TradersTable } from "./TradersTable";

/** Perp Scout's two sections: the followed traders' open entries (with
 * Refresh prices, current mids swapped in without a scan) and the traders. */
export function PerpScoutView({ scan, signedIn, serverNowSec }: { scan: ScoutScan | null; signedIn: boolean; serverNowSec: number }) {
  const [mids, setMids] = useState<{ at: number; mids: Record<string, number> } | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const names = Object.fromEntries(FOLLOWED.map((f) => [f.address, f.name]));
  const entries = scan?.entries ?? [];

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
              {priceError ? <span className="text-warning">{priceError}</span> : mids ? <AgeText at={mids.at} serverNowSec={serverNowSec} prefix="Prices " /> : scan ? <AgeText at={scan.scannedAt} serverNowSec={serverNowSec} prefix="Prices from the scan, " /> : null}
            </span>
          </div>
        }
      >
        {scan ? (
          <EntriesTable entries={entries} names={names} mids={mids?.mids ?? null} serverNowSec={serverNowSec} />
        ) : (
          <p className="text-sm text-fg-muted">{signedIn ? "Press Scan to read the followed traders\u2019 open positions." : "Log in and press Scan to read the followed traders\u2019 open positions."}</p>
        )}
      </Panel>

      <CollapsiblePanel
        storageKey="cryptoport:perpScoutTradersOpen"
        density="normal"
        title={
          <span className="inline-flex items-center gap-1.5">
            Traders
            <InfoTooltip>
              The traders Perp Scout follows, picked in chat with Claude (src/lib/perpScout/followed.ts) — ask there to add or drop one. Perps record (all-time and 30-day PnL, winning weeks, max drawdown of the PnL curve ÷ the account\u2019s typical value, best-4-weeks share), equity (the whole account, perps + spot), leverage, book and open positions are from the last scan; before a trader\u2019s first scan, the figures they were picked on.
            </InfoTooltip>
          </span>
        }
        summary={<span className="text-xs text-fg-muted">{FOLLOWED.length} followed</span>}
      >
        {FOLLOWED.length ? <TradersTable followed={FOLLOWED} books={scan?.books ?? []} /> : <p className="text-sm text-fg-muted">No traders on the list yet.</p>}
      </CollapsiblePanel>
    </div>
  );
}

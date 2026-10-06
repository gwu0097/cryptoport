"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { CollapsiblePanel } from "@/components/ui/CollapsiblePanel";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Button } from "@/components/ui/Button";
import { AgeText } from "@/components/AgeText";
import { useNowSec } from "@/components/useServerNow";
import type { PerpScoutState } from "@/lib/perpScoutScan";
import { EntriesTable } from "./EntriesTable";
import { TradersTable } from "./TradersTable";
import { AddTraderForm } from "./AddTraderForm";
import { ExportTradersButton, ImportTraders } from "./TraderListFile";
import { CLOSES_DAYS } from "@/lib/perpScout/closes";
import { TrackedPanel } from "./TrackedPanel";
import { useScoutMids } from "./useScoutMids";

/** Perp Scout's sections, each collapsible: the user's tracked trades, the
 * followed traders' activity (with Refresh prices, current mids swapped in
 * without a scan — shared with the tracked trades) and the traders. */
export function PerpScoutView({ state, signedIn, isOwner, serverNowSec }: { state: PerpScoutState; signedIn: boolean; isOwner: boolean; serverNowSec: number }) {
  const { scan, traders, tracked } = state;
  const nowMs = useNowSec(serverNowSec) * 1000;
  const prices = useScoutMids(true);
  const { pricing, error: priceError } = prices;
  const mids = prices.mids && prices.at ? { mids: prices.mids, at: prices.at } : null;
  const names = Object.fromEntries(traders.map((f) => [f.address, f.name]));
  const entries = scan?.entries ?? [];

  return (
    <div className="space-y-6">
      <TrackedPanel
        tracked={tracked}
        entries={entries}
        closes={scan?.closes ?? []}
        names={names}
        prices={prices}
        books={scan?.books ?? []}
        serverNowSec={serverNowSec}
        signedIn={signedIn}
      />

      <CollapsiblePanel
        storageKey="cryptoport:perpScoutActivityOpen"
        density="normal"
        summary={<span className="text-xs text-fg-muted">{entries.length} open · {scan?.closes?.length ?? 0} closes</span>}
        title={
          <span className="inline-flex items-center gap-1.5">
            Activity
            <InfoTooltip>
              Every open position of the followed traders, and every position they closed in the last {CLOSES_DAYS} days (grey &quot;Closed&quot; rows: entry → exit, the return at 1× and the realized PnL before fees). &quot;Moved&quot; counts opens, adds, trims and closes. &quot;vs entry&quot; is how far price has moved since their average entry, in their direction: negative means they&apos;re down — the price now is better than theirs (below it on a long, above it on a short). &quot;Role&quot; is read from the rest of the trader&apos;s book (hover it for why): Paired = opened with an opposite position within 2 h; Hedge = against a book that clearly leans the other way; Book leg = one side of a balanced long/short book; Directional = with the book&apos;s lean, or their only position. &quot;Their gain&quot; is their return on margin (the move × their leverage, Hyperliquid&apos;s ROE), with their dollar PnL beside it; &quot;vs entry&quot; is your gain at 1×, whatever your size. &quot;Trader 30d&quot; is their perps PnL over the last 30 days. &quot;Group by coin&quot; shows the coins several traders hold first. &quot;First fill&quot; is the price of the order that opened the position, when it&apos;s within their latest 2,000 fills; &quot;over Nd&quot; means it was opened before those. Observations, not signals.
            </InfoTooltip>
          </span>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button variant="secondary" size="sm" disabled={pricing || !signedIn || entries.length === 0} onClick={() => void prices.refresh()} title={signedIn ? "Current prices from Hyperliquid (one call)" : "Sign in to refresh prices"}>
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
          <EntriesTable entries={entries} closes={scan?.closes ?? []} books={scan?.books ?? []} names={names} mids={mids?.mids ?? null} serverNowSec={serverNowSec} tracked={tracked} canTrack={signedIn} />
        ) : (
          <p className="text-sm text-fg-muted">{signedIn ? "Press Scan to read the followed traders\u2019 open positions." : "Log in and press Scan to read the followed traders\u2019 open positions."}</p>
        )}
      </CollapsiblePanel>


      <CollapsiblePanel
        storageKey="cryptoport:perpScoutTradersOpen"
        density="normal"
        title={
          <span className="inline-flex items-center gap-1.5">
            Traders
            <InfoTooltip>
              The traders Perp Scout follows: picked in chat with Claude (src/lib/perpScout/followed.ts), plus any the owner added by address below (positions show after the next Scan). The owner can remove any trader with ✕; a removed one comes back by adding its address again. Perps record (all-time PnL with its % of the account&apos;s typical value, 30-day PnL with its % of the account now, winning weeks, max drawdown of the PnL curve ÷ the account&apos;s typical value, best-4-weeks share), equity (the whole account, perps + spot), leverage, book and open positions are from the last scan; before a trader&apos;s first scan, the figures they were picked on.
            </InfoTooltip>
          </span>
        }
        summary={<span className="text-xs text-fg-muted">{traders.length} followed</span>}
        actions={<ExportTradersButton traders={traders} />}
      >
        {traders.length ? <TradersTable followed={traders} books={scan?.books ?? []} entries={entries} mids={mids?.mids ?? null} nowMs={nowMs} removable={isOwner ? traders.map((f) => f.address) : []} /> : <p className="text-sm text-fg-muted">No traders on the list yet.</p>}
        {isOwner && (
          <>
            <AddTraderForm />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ImportTraders />
            </div>
          </>
        )}
      </CollapsiblePanel>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Star } from "lucide-react";
import { CollapsiblePanel } from "@/components/ui/CollapsiblePanel";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Button } from "@/components/ui/Button";
import { AgeText } from "@/components/AgeText";
import type { TrackedTrade } from "@/lib/perpScout/tracked";
import type { ScoutEntry } from "@/lib/perpScout/entries";
import { CLOSES_DAYS, type ScoutClose } from "@/lib/perpScout/closes";
import type { ScoutBook } from "@/lib/perpScoutScan";
import { TrackedTable } from "./TrackedTable";
import type { ScoutMids } from "./useScoutMids";

/**
 * The user's tracked trades as a collapsible card (Perp Scout's first
 * section, and the Dashboard's beside Open positions). Two buttons, as the
 * owner asked (2026-10-06): Refresh prices only swaps in current prices
 * (one allMids call); Refresh re-reads the traders behind the tracked
 * trades (api/perp-scout/tracked/refresh — positions and the fills since
 * the last read), so a close, add or trim shows without a full Scan.
 */
export function TrackedPanel({
  tracked,
  entries,
  closes,
  names,
  prices,
  books,
  serverNowSec,
  signedIn,
  compact = false,
  storageKey = "cryptoport:perpScoutTrackedOpen",
}: {
  tracked: readonly TrackedTrade[];
  entries: readonly ScoutEntry[];
  closes: readonly (ScoutClose & { iconUrl?: string | null })[];
  names: Record<string, string>;
  prices: ScoutMids;
  books: readonly ScoutBook[];
  serverNowSec: number;
  signedIn: boolean;
  compact?: boolean;
  storageKey?: string;
}) {
  const router = useRouter();
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function refreshPositions() {
    setReading(true);
    setNote(null);
    try {
      const res = await fetch("/api/perp-scout/tracked/refresh", { method: "POST", cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { status?: string; failed?: number; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.status === "busy") setNote("A scan is running — its results will show when it finishes.");
      else if (body.failed) setNote(`${body.failed} trader${body.failed === 1 ? "" : "s"} couldn't be read; their last positions are kept.`);
      // The positions just read carry newer marks than any earlier mids.
      prices.clear();
      router.refresh();
    } catch (e) {
      setNote(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setReading(false);
    }
  }

  const busy = reading || prices.pricing;
  // When these trades' traders were last read (the oldest of them).
  const traders = new Set(tracked.map((t) => t.address));
  const readAt = books.filter((b) => traders.has(b.address) && b.readAt).map((b) => b.readAt as string).sort()[0] ?? null;
  return (
    <CollapsiblePanel
      storageKey={storageKey}
      density="normal"
      className="h-full"
      title={
        <span className="inline-flex items-center gap-1.5">
          <Star className="size-4 text-warning" fill="currentColor" aria-hidden="true" />
          Tracked trades
          <InfoTooltip>
            Trades you marked with ☆ in Perp Scout&apos;s Activity table, each followed until it closes: Open (with the trader&apos;s latest add or trim), Take-profit hit or Stopped out (the exit within 0.5% of the TP or SL it had when you marked it), Closed, or Not seen (closed longer ago than the {CLOSES_DAYS} days of closes kept, or the trader wasn&apos;t read). &quot;Since tracked&quot; is the move since you marked it, in their direction, at 1× — what you&apos;d have if you followed then. Refresh prices updates prices only (one Hyperliquid call; the app&apos;s Refresh prices does it too); Refresh re-reads the traders behind these trades, so closes, adds and trims show without a full Scan.
          </InfoTooltip>
        </span>
      }
      summary={<span className="text-xs text-fg-muted">{tracked.length} tracked</span>}
      actions={
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy || !signedIn || tracked.length === 0} onClick={() => void prices.refresh()} title="Current prices from Hyperliquid (one call)">
              {prices.pricing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
              Refresh prices
            </Button>
            <Button variant="secondary" size="sm" disabled={busy || !signedIn || tracked.length === 0} onClick={refreshPositions} title="Re-read these traders' positions: closes, adds and trims">
              {reading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
              {reading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <span className="text-xs text-fg-muted">
            {note ? (
              <span className="text-warning">{note}</span>
            ) : prices.error ? (
              <span className="text-warning">{prices.error}</span>
            ) : prices.at ? (
              <AgeText at={prices.at} serverNowSec={serverNowSec} prefix="Prices " />
            ) : readAt ? (
              <AgeText at={readAt} serverNowSec={serverNowSec} prefix="Positions read " />
            ) : null}
          </span>
        </div>
      }
    >
      {signedIn ? (
        <TrackedTable tracked={tracked} entries={entries} closes={closes} names={names} mids={prices.mids} serverNowSec={serverNowSec} canEdit compact={compact} />
      ) : (
        <p className="text-sm text-fg-muted">Log in to track trades.</p>
      )}
    </CollapsiblePanel>
  );
}

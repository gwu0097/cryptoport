"use client";

import { formatUsdSigned, formatPercent } from "@/lib/format";
import type { BlendedChange } from "@/lib/dashboard";
import { useHideBalance } from "./HideBalanceProvider";

/**
 * Dashboard's "+$10,093.07 (+2.57%) as of last refresh · based on 100% of
 * tracked value" line under the (maskable) Total value headline — its own
 * client component specifically so it can consult useHideBalance and drop
 * the raw $ delta while privacy mode is on. Reported directly: showing
 * this $ figure right next to a masked total defeated the point of
 * masking (total = delta / pct recovers it) — the % on its own doesn't
 * reveal portfolio size the way a $ amount does, so it's kept even while
 * hidden.
 */
export function BlendedChangeCaption({ change }: { change: BlendedChange }) {
  const { hidden } = useHideBalance();
  return (
    <p
      className={`mt-1 text-sm tabular-nums ${
        change.pct > 0 ? "text-positive" : change.pct < 0 ? "text-negative" : "text-fg-muted"
      }`}
    >
      {hidden ? formatPercent(change.pct) : `${formatUsdSigned(change.usd)} (${formatPercent(change.pct)})`} as of
      last refresh · based on {change.coveragePct.toFixed(0)}% of tracked value
    </p>
  );
}

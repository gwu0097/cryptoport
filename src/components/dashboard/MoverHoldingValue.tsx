"use client";

import { useHideBalance } from "@/components/HideBalanceProvider";
import { formatCompactUsd } from "@/lib/format";

/**
 * The "(how much of this I actually hold)" figure next to a mover row —
 * unlike the row's own market price (doesn't reveal portfolio size, per
 * HideBalanceProvider's own doc comment on what needs masking), a position
 * value does, so this gates on the shared privacy toggle. Direct ask: only
 * show it when the eye is on — not masked-when-off, omitted entirely, so
 * there's nothing in the DOM hinting a value exists when hiding is on.
 * A tiny dedicated client component (not making all of MoverList client)
 * since everything else in that list is plain server-rendered markup.
 */
export function MoverHoldingValue({ usd }: { usd: number | undefined }) {
  const { hidden } = useHideBalance();
  if (usd === undefined || hidden) return null;
  return <span className="shrink-0 text-xs text-fg-muted">({formatCompactUsd(usd)})</span>;
}

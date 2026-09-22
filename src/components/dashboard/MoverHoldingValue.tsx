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
// Size tiers, not sentiment — deliberately NOT text-positive/text-negative
// (those already mean "gained/lost" on the very same row, via ChangeText;
// reusing them here for position size would read as "small = bad, large =
// good" or the reverse, neither of which is true). Genuinely distinct
// hues, not an intensity ramp on one color — reported directly that a
// muted/default/accent escalation was unreadable ("the white blends in
// with the ticker name"), since the ticker itself is already text-fg.
// Three of this app's existing semantic colors, still clear of red/green:
// muted gray (fades a small position into the background), accent blue
// (a real, deliberate mid-tier), warning amber (the one that should
// actually catch your eye — reads as "this is a big position," same
// "gold tier" association amber/gold carries in most tiered-UI
// conventions, not a caution here).
function tierClass(usd: number): string {
  if (usd < 1_000) return "text-fg-muted";
  if (usd < 10_000) return "text-accent";
  return "text-warning font-semibold";
}

export function MoverHoldingValue({ usd }: { usd: number | undefined }) {
  const { hidden } = useHideBalance();
  if (usd === undefined || hidden) return null;
  return <span className={`shrink-0 text-xs ${tierClass(usd)}`}>({formatCompactUsd(usd)})</span>;
}

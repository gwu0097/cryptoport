"use client";

import { useRouter } from "next/navigation";
import { TokenIcon } from "./TokenIcon";

/**
 * A plain `<select>` needs an onChange handler to navigate — same
 * "no way to make a native select itself a link" reasoning as
 * TransactionsWalletFilter, generalized to take pre-built hrefs (each
 * option's own buildHref result, same as the visible cards use) instead of
 * reconstructing a URL from parts, so this works for both the chain row and
 * the protocol row without knowing either one's own query-param shape.
 * Styled to sit inline as the last card in a 2-row grid (see
 * ChainGroupedHoldings), not as a standalone form control.
 */
export function MoreFilterPicker({
  label,
  options,
  active,
  compact = false,
}: {
  label: string;
  options: { key: string; label: string; href: string; icon: string | null }[];
  /** The option currently selected, if the active filter is one of the
   * overflowed ones — so the picker shows what's actually selected instead
   * of always reverting to its own placeholder. */
  active?: { key: string; label: string; icon: string | null };
  /** Matches the protocol row's own smaller card styling (see
   * ChainGroupedHoldings' cardClass) — the chain row stays the original
   * size. */
  compact?: boolean;
}) {
  const router = useRouter();

  return (
    <label
      className={`flex cursor-pointer flex-col justify-center gap-0.5 rounded-lg border border-border bg-surface text-left transition hover:border-accent/50 hover:bg-surface-raised ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}
    >
      <span className={`flex items-center gap-1.5 truncate font-medium text-fg ${compact ? "text-xs" : "text-sm"}`}>
        {active ? (
          <>
            <TokenIcon ticker={active.label} url={active.icon} size={compact ? "sm" : "md"} />
            <span className="truncate">{active.label}</span>
          </>
        ) : (
          label
        )}
      </span>
      <select
        aria-label={label}
        value=""
        onChange={(e) => {
          if (e.target.value) router.push(e.target.value);
        }}
        className="w-full cursor-pointer appearance-none border-0 bg-transparent p-0 text-[11px] text-fg-muted focus:outline-none"
      >
        <option value="" disabled>
          {active ? "Change…" : `${options.length} more…`}
        </option>
        {options.map((o) => (
          <option key={o.key} value={o.href}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

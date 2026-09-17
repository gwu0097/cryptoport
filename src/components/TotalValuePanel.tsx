"use client";

import { type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { formatUsd } from "@/lib/format";
import { Panel } from "./ui/Panel";
import { useHideBalance } from "./HideBalanceProvider";

const MASK = "••••••";

/**
 * The "Total value" summary block shared by every page that shows a
 * portfolio/wallet/protocol total — portfolio, assets, defi, dashboard,
 * wallets list, and a single wallet's detail page. Only the genuinely
 * identical part (the label + big number) is pulled out here; each page's
 * own caption lines below it (an unpriced-count warning, a blended 24h
 * change, a sync-error notice, wallet notes...) stay page-specific,
 * composed via children in whatever order/combination that page needs —
 * this used to be six independently hand-copied versions of the whole
 * block (three near-identical, two each extended with a different extra
 * line, and one that silently dropped the unpriced warning other pages
 * all show for the same underlying data).
 *
 * This component only masks its own headline number — a page's own
 * caption lines (children) are that page's content, not this shared
 * component's to reach into. But any child that itself derives a raw
 * dollar figure from the total (not an individual holding's own price)
 * needs to mask that figure too, via HideBalanceProvider's exported
 * `useHideBalance` hook (a shared context, not a per-component
 * usePersistedState call — see that file's own doc comment for the real
 * cross-component sync bug that distinction fixes) — a masked total
 * sitting next to an unmasked $ delta right below it defeats the point
 * (delta / pct recovers the total). See BlendedChangeCaption for the one
 * place this actually came up.
 *
 * Label and number read as one inline phrase ("Total value: $X", eye right
 * after it) on the row's left edge, rather than label-left/number-right
 * spanning the whole row — that split read as two unrelated pieces of a
 * wide, mostly-empty line. `actions` is an optional right-of-that slot
 * (e.g. Dashboard's own "Refresh prices" button + its "Last priced"
 * caption), pinned to the row's right edge via `ml-auto` when present —
 * so a page can fold its own header action into this same box instead of
 * giving it a separate row above, without disturbing every other page
 * that doesn't pass one.
 */
export function TotalValuePanel({
  total,
  actions,
  children,
}: {
  total: number;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { hidden, setHidden } = useHideBalance();

  return (
    <Panel className="mb-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <p className="text-lg font-semibold tabular-nums text-fg">
            <span className="text-sm font-normal text-fg-muted">Total value: </span>
            {hidden ? MASK : formatUsd(total)}
          </p>
          <button
            type="button"
            onClick={() => setHidden(!hidden)}
            aria-label={hidden ? "Show total value" : "Hide total value"}
            aria-pressed={hidden}
            className="rounded p-0.5 text-fg-muted transition hover:text-fg"
          >
            {hidden ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
          </button>
        </div>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {children}
    </Panel>
  );
}

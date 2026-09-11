"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { formatUsd } from "@/lib/format";
import { Panel } from "./ui/Panel";
import { usePersistedState } from "./usePersistedState";

// Shared across every page that renders TotalValuePanel (see its own doc
// comment) — one toggle, one stored preference, so hiding it anywhere
// hides it everywhere the same way a real "privacy mode" would, rather
// than each page needing its own separate on/off state.
const HIDE_BALANCE_KEY = "cryptoport:hideBalance";
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
 * The eye toggle only masks this headline number, not `children` — a
 * page's own caption lines (24h $ change, etc.) are that page's content,
 * not this shared component's to reach into.
 *
 * Label and number read as one inline phrase ("Total value: $X", eye right
 * after it) pinned to the row's right edge via `ml-auto`, rather than
 * label-left/number-right spanning the whole row — that split read as two
 * unrelated pieces of a wide, mostly-empty line. `actions` is an optional
 * left-of-that slot (e.g. Dashboard's own "Refresh prices" button + its
 * "Last priced" caption) so a page can fold its own header action into
 * this same box instead of giving it a separate row above — `ml-auto` on
 * the value phrase still pins it to the right even when `actions` is
 * omitted, so every other page renders exactly as before.
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
  const [hidden, setHidden] = usePersistedState(HIDE_BALANCE_KEY, false);
  // usePersistedState seeds `false` (localStorage isn't available during
  // SSR) and only swaps in the real stored value post-mount — without this,
  // the server-rendered HTML always contains the real number, so anyone
  // who'd turned hiding on would still see it flash on-screen for a beat
  // on every page load/navigation before the effect catches up. Masked
  // until this component has actually mounted client-side closes that.
  const [mounted, setMounted] = useState(false);
  // Same SSR/hydration exception usePersistedState.ts's own read effect
  // documents — this synchronizes with "has the client actually taken
  // over yet," not state derivable during render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  const masked = !mounted || hidden;

  return (
    <Panel className="mb-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {actions}
        <div className="ml-auto flex items-center gap-1.5">
          <p className="text-lg font-semibold tabular-nums text-fg">
            <span className="text-sm font-normal text-fg-muted">Total value: </span>
            {masked ? MASK : formatUsd(total)}
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
      </div>
      {children}
    </Panel>
  );
}

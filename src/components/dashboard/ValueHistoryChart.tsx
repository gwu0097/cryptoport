import { LineChart } from "lucide-react";
import type { PortfolioHistoryPoint } from "@/lib/queries";
import { Panel } from "../ui/Panel";
import { ValueChart } from "../charts/ValueChart";

const RANGE_STORAGE_KEY = "cryptoport:dashboardRange";

/**
 * Dashboard's own value-history panel — renders through the same shared
 * ValueChart as Analytics' PerformanceChart (range picker + Robinhood-
 * style hover scrub, see that component's own doc comment for why this
 * exists as one shared piece rather than two). portfolio_snapshots only
 * accumulates one row per day (see snapshots.ts), so this will only ever
 * have a handful of points for the first few weeks, but the same range
 * picker still works correctly once there's more — "90D"/"1Y"/"All" just
 * return everything available until real history actually spans that far.
 *
 * Every point here is real (this app's daily snapshot cron), never
 * estimated — Dashboard doesn't do the pre-history backfill Analytics
 * does — so `kind: "real"` on every point is a fixed mapping, not
 * something this page's data ever varies.
 */
export function ValueHistoryChart({ points }: { points: PortfolioHistoryPoint[] }) {
  if (points.length < 2) {
    // Same centered icon + message shape as SignInPrompt/ComingSoon (their
    // own doc comments call this the shared empty-state pattern) —
    // min-h-64 + place-items-center means this panel still reads as a
    // deliberate empty state rather than a mostly-blank box, including
    // where it sits in /dashboard's 2-column grid next to a much taller
    // panel and gets stretched to match.
    return (
      <Panel className="grid min-h-64 place-items-center text-center">
        <div className="flex flex-col items-center gap-3">
          <LineChart className="size-10 text-fg-muted" aria-hidden="true" />
          <p className="max-w-sm text-sm text-fg-muted">
            Building your value history — check back in a few days. A snapshot is captured once a day.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Value history">
      <ValueChart
        points={points.map((p) => ({ ...p, kind: "real" as const }))}
        rangeStorageKey={RANGE_STORAGE_KEY}
      />
      {/* Reported directly as a "discrepancy" between this chart's headline
          and the live Total value panel above it — see snapshots.ts's
          captureUserSnapshot for the actual fix (a manual refresh/sync now
          updates today's snapshot too, not just the once-daily cron).
          This caption covers the narrower gap that's left: between two
          refreshes, prices keep moving live while today's snapshot sits at
          whatever the last one captured. */}
      <p className="mt-2 text-xs text-fg-muted">
        Updates when you refresh prices or sync a wallet — may lag Total value above between refreshes.
      </p>
    </Panel>
  );
}

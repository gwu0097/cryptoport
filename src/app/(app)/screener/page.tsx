import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ScreenerUniverseTable } from "@/components/screener/ScreenerUniverseTable";
import { getLatestUniverseSnapshot } from "@/lib/screener/queries";
import { formatStaleness } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Screener universe · CryptoPort" };

/**
 * Phase 1's spot-check deliverable, not the real screener UI — no grades,
 * tiers, setup tags, or filters yet (those need Phase 2/3's scoring engine,
 * which doesn't exist). Deliberately not linked from the main nav for the
 * same reason: this page exists so the raw universe/snapshot pipeline can
 * be checked against defillama.com and coingecko.com by hand, not for
 * regular use yet. Public (no requireUser()) — same reasoning as Trend
 * Finder/Encyclopedia: market-wide research data, not personal holdings.
 */
export default async function ScreenerUniversePage() {
  const { runId, runStartedAt, rows, unmatchedCount, conflictCount } = await getLatestUniverseSnapshot();

  return (
    <>
      <PageHeader
        title="Screener universe (Phase 1 spot-check)"
        subtitle="Covers revenue-generating app tokens only; BTC, ETH, L1s, and memecoins excluded by design."
      />

      {!runId ? (
        <Panel>
          <p className="text-sm text-fg-muted">
            No successful snapshot run yet — the daily job (`/api/cron/screener-snapshot`) hasn&rsquo;t completed a
            run. Trigger it manually (`vercel crons run /api/cron/screener-snapshot`) or wait for its next scheduled
            run.
          </p>
        </Panel>
      ) : (
        <>
          <Panel className="mb-4">
            <p className="text-sm text-fg-muted">
              Latest run: {formatStaleness(runStartedAt)} · {rows.length} matched assets · {unmatchedCount} unmatched
              (open intervals in `screener_unmatched`) · {conflictCount} source conflict{conflictCount === 1 ? "" : "s"} flagged.
            </p>
          </Panel>
          <Panel padding={false}>
            <ScreenerUniverseTable rows={rows} />
          </Panel>
        </>
      )}

      <p className="mt-4 text-xs text-fg-muted">Research tool, not financial advice.</p>
    </>
  );
}

import Link from "next/link";
import { AgeText } from "@/components/AgeText";
import { requestNowSec } from "@/lib/requestClock";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ScreenerUniverseTable } from "@/components/screener/ScreenerUniverseTable";
import { getLatestUniverseSnapshot } from "@/lib/screener/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fundamentals universe · CryptoPort" };

/**
 * Phase 1's spot-check surface: the raw universe of the latest run, to check
 * values against defillama.com and coingecko.com by hand. Moved here from
 * /screener in Phase 3b, when /screener became the real (graded) screener.
 * Not linked from the main nav. Public (no requireUser()) — same reasoning as Trend
 * Finder/Encyclopedia: market-wide research data, not personal holdings.
 */
export default async function ScreenerUniversePage() {
  const { runId, runStartedAt, rows, unmatchedCount, conflictCount } = await getLatestUniverseSnapshot();

  return (
    <>
      <PageHeader
        title="Fundamentals universe (raw spot-check)"
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
              Latest run: <AgeText at={runStartedAt} serverNowSec={requestNowSec()} /> · {rows.length} matched assets · {unmatchedCount} unmatched
              (open intervals in `screener_unmatched`) · {conflictCount} source conflict{conflictCount === 1 ? "" : "s"} flagged.
            </p>
          </Panel>
          <Panel padding={false}>
            <ScreenerUniverseTable rows={rows} />
          </Panel>
        </>
      )}

      <p className="mt-4 text-xs text-fg-muted">
        <Link href="/screener" className="underline hover:text-fg">
          Back to Fundamentals
        </Link>{" "}
        · Research tool, not financial advice.
      </p>
    </>
  );
}

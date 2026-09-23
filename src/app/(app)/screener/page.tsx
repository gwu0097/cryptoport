import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { RegimePanel } from "@/components/screener/RegimePanel";
import { ScreenerScoresTable } from "@/components/screener/ScreenerScoresTable";
import { getScreenerView } from "@/lib/screener/queries";
import { formatStaleness } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Screener · CryptoPort" };

const GATE_LABEL: Record<string, string> = {
  core_data: "missing price, market cap or revenue",
  out_of_scope: "out of scope (chain, meme, or a scope override)",
  mcap_floor: "market cap under $10M",
  liquidity: "24h volume under $2M",
  revenue_floor: "annualized revenue under $1M",
  unlock_overhang: "unlock overhang",
  collapsing_revenue: "revenue down > 60% vs prior 90d",
};

/**
 * Phase 3b: the real screener. Shows the latest day's run, picked by the one
 * shared rule (SPEC "One run per UTC day": the day's latest ok live run).
 * Ranked by Score B (momentum vs BTC), with the Quality & Risk tier and the
 * setup tag next to each asset, and the market regime with all its inputs.
 * URL-only (not in the sidebar) until Phase 4 validates something, and every
 * view carries the "unvalidated" banner. Public, like Trend Finder: market-
 * wide research data, not personal holdings.
 */
export default async function ScreenerPage() {
  const view = await getScreenerView();

  return (
    <>
      <PageHeader
        title="Screener"
        subtitle="Revenue-generating tokens ranked by momentum vs BTC, with a risk tier and a setup tag. BTC, ETH, L1s and memecoins are excluded by design."
      />

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-fg">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <p>
          <span className="font-semibold">Unvalidated screen: grades are not yet backtested.</span>{" "}
          <span className="text-fg-muted">
            Grades, terciles and tags are percentile cuts with starting thresholds. None has been tested for predictive
            value yet (Phase 4).
          </span>
        </p>
      </div>

      {!view.run ? (
        <Panel>
          <p className="text-sm text-fg-muted">
            No successful live snapshot yet. The daily job (`/api/cron/screener-snapshot`, 07:00 UTC) hasn&rsquo;t
            completed a run.
          </p>
        </Panel>
      ) : (
        <>
          <p className="mb-4 text-sm text-fg-muted">
            Run of {view.run.startedAt.slice(0, 10)} (UTC), {formatStaleness(view.run.startedAt)}
            {view.run.trigger === "vercel-cron" ? " · scheduled" : " · manual"} · {view.ratedCount} rated ·{" "}
            {view.unrated.total} unrated. Data is refreshed once a day; the day&rsquo;s latest successful run is shown.
          </p>

          {view.regime ? (
            <div className="mb-4">
              <RegimePanel label={view.regime.label} rules={view.regime.rules} />
            </div>
          ) : (
            <Panel className="mb-4">
              <p className="text-sm text-fg-muted">No market-regime reading for this run (the regime step didn&rsquo;t record one).</p>
            </Panel>
          )}

          {view.scoresMissingReason ? (
            <Panel className="mb-4">
              <p className="text-sm text-fg-muted">{view.scoresMissingReason}</p>
            </Panel>
          ) : (
            <>
              <Panel
                padding={false}
                className="mb-4"
                title={<span className="block px-5 pt-5">Ranked ({view.graded.length})</span>}
                description={
                  <span className="block px-5">
                    Rated assets with a full momentum history. Score B is the mean of the 3-week and 12-week momentum
                    percentiles vs BTC; percentile and grade are among these assets. Setup = risk tier × momentum third.
                    High risk caps the grade at C (the raw grade is shown next to it). Risk tier: only the revenue-drop
                    rule can be evaluated today (dilution needs 90 days of our own supply history, from ~2026-12-21; no
                    unlock data yet), so &ldquo;Pass&rdquo; mostly means &ldquo;nothing we can check fired&rdquo;.
                    {view.sizeCheck?.flagged && (
                      <span className="mt-1 block text-warning">
                        Size check: {Math.round((view.sizeCheck.share ?? 0) * 100)}% of the top third is{" "}
                        {view.sizeCheck.dominant}-cap. The ranking may be picking up a size effect.
                      </span>
                    )}
                  </span>
                }
              >
                <ScreenerScoresTable rows={view.graded} variant="graded" />
              </Panel>

              {view.insufficientHistory.length > 0 && (
                <Panel
                  padding={false}
                  className="mb-4"
                  title={<span className="block px-5 pt-5">Insufficient history ({view.insufficientHistory.length})</span>}
                  description={
                    <span className="block px-5">
                      Rated, but only one momentum leg exists (usually too new for 12 weeks of price history). A
                      one-leg score isn&rsquo;t comparable to a two-leg average: it lands at the extremes by
                      construction. So these are placed against the ranked distribution for reference, but never
                      graded, tagged or ranked.
                    </span>
                  }
                >
                  <ScreenerScoresTable rows={view.insufficientHistory} variant="insufficient" />
                </Panel>
              )}
              {view.unscoredCount > 0 && (
                <p className="mb-4 text-sm text-fg-muted">
                  {view.unscoredCount} rated asset{view.unscoredCount === 1 ? " has" : "s have"} no momentum history at
                  all and {view.unscoredCount === 1 ? "is" : "are"} not scored.
                </p>
              )}
            </>
          )}

          <Panel title={`Unrated (${view.unrated.total})`} description="An asset is unrated when any kill filter fails. One asset can fail several.">
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {Object.entries(view.unrated.failedByGate)
                .sort((a, b) => b[1] - a[1])
                .map(([gate, n]) => (
                  <li key={gate} className="flex justify-between gap-4">
                    <span className="text-fg-muted">{GATE_LABEL[gate] ?? gate}</span>
                    <span className="tabular-nums">{n}</span>
                  </li>
                ))}
            </ul>
          </Panel>
        </>
      )}

      <p className="mt-4 text-xs text-fg-muted">
        <Link href="/screener/universe" className="underline hover:text-fg">
          Raw universe (spot-check)
        </Link>{" "}
        · Research tool, not financial advice.
      </p>
    </>
  );
}

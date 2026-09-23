import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { RegimePanel } from "@/components/screener/RegimePanel";
import { ScreenerViews } from "@/components/screener/ScreenerViews";
import { getScreenerView, getLatestBacktestSummary } from "@/lib/screener/queries";
import { formatStaleness } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fundamentals · CryptoPort" };

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
 * The screener: the latest day's run, picked by the one shared rule (SPEC
 * "One run per UTC day": the day's latest ok live run). Since Phase 4 (SPEC
 * "Product") the default view is a research table (verified fundamentals,
 * kill filters, risk tier, valuation and momentum as sortable columns); the
 * Phase 3 momentum ranking is behind an experimental toggle (ScreenerViews).
 * The market regime is shown with all its inputs.
 * In the sidebar (Research) since 2026-09-23: the URL-only restriction
 * existed because grades were the default view; the research table is
 * defensible on its own. The "unvalidated" banner stays on every view. Public, like Trend Finder: market-
 * wide research data, not personal holdings.
 */
export default async function ScreenerPage() {
  const [view, backtest] = await Promise.all([getScreenerView(), getLatestBacktestSummary()]);

  return (
    <>
      <PageHeader
        title="Fundamentals"
        subtitle="A verified research dataset of revenue-generating tokens, with a risk filter. Not a signal: nothing here is ranked or recommended. BTC, ETH, L1s and memecoins are excluded by design."
      />

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-fg">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <p>
          <span className="font-semibold">Unvalidated screen: grades have not passed a backtest.</span>{" "}
          <span className="text-fg-muted">
            Grades, terciles and tags are percentile cuts with starting thresholds, not predictions.
          </span>
          {backtest && (
            <span className="mt-1 block">
              Backtest {backtest.finishedAt.slice(0, 10)} (run {backtest.id.slice(0, 8)}): {backtest.summary}
            </span>
          )}
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

          {view.run.degraded && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-negative/40 bg-negative/10 p-4 text-sm text-fg">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden="true" />
              <p>
                <span className="font-semibold">Degraded day: CoinGecko was unavailable for this run.</span>{" "}
                <span className="text-fg-muted">
                  The snapshot was still written from DefiLlama (price, fees, revenue, TVL) so the history stays
                  continuous, but market cap, supply and volume are missing, so no asset can be rated today
                  {view.run.degraded.pricesMissing > 0 ? `, and ${view.run.degraded.pricesMissing} assets also had no DefiLlama price` : ""}.
                  Degraded days are excluded from backtests. Error: {view.run.degraded.error}
                </span>
              </p>
            </div>
          )}

          {view.regime ? (
            <div className="mb-4">
              <RegimePanel label={view.regime.label} rules={view.regime.rules} />
            </div>
          ) : (
            <Panel className="mb-4">
              <p className="text-sm text-fg-muted">No market-regime reading for this run (the regime step didn&rsquo;t record one).</p>
            </Panel>
          )}

          <ScreenerViews view={view} />

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

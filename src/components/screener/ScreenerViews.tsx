"use client";

import { useState } from "react";
import { Panel } from "@/components/ui/Panel";
import { ResearchTable } from "@/components/screener/ResearchTable";
import { ScreenerScoresTable } from "@/components/screener/ScreenerScoresTable";
import type { ScreenerView } from "@/lib/screener/queries";

/**
 * Default: the research table (SPEC "Product": a verified research dataset
 * with a risk filter, not a signal). The Phase 3 momentum ranking — grades,
 * setup tags, ranked order, the insufficient-history section — is kept only
 * behind this EXPERIMENTAL toggle, so later backtests can still be run
 * against it and compared. Plain component state, deliberately NOT
 * persisted: every visit starts on the research table.
 */
export function ScreenerViews({
  view,
}: {
  view: Pick<ScreenerView, "research" | "graded" | "insufficientHistory" | "unscoredCount" | "sizeCheck" | "scoresMissingReason" | "ratedCount">;
}) {
  const [experimental, setExperimental] = useState(false);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">
          {experimental
            ? "Experimental: the Phase 3 momentum ranking. Kept for re-testing only; its order has no demonstrated predictive value."
            : "Research view: every rated asset with its verified fundamentals, risk tier, valuation and momentum. No ranking."}
        </p>
        <button
          type="button"
          onClick={() => setExperimental((v) => !v)}
          className="rounded-full border border-border px-3 py-1 text-xs text-fg-muted hover:border-accent hover:text-fg"
        >
          {experimental ? "Back to the research table" : "Show the experimental momentum ranking"}
        </button>
      </div>

      {!experimental ? (
        <Panel
          padding={false}
          className="mb-4"
          title={<span className="block px-5 pt-5">Rated assets ({view.ratedCount})</span>}
          description={
            <span className="block px-5">
              Rated = passed every kill filter (market cap ≥ $10M, 24h volume ≥ $2M, revenue ≥ $1M/yr, in scope, no
              revenue collapse). Revenue and fees are annualized from DefiLlama&rsquo;s last 30 days; P/S and P/F are
              market cap ÷ those. Momentum is the change vs BTC. Risk tier: only the revenue-drop rule can be evaluated
              today (dilution needs 90 days of our own supply history, from ~2026-12-21; no unlock data yet), so
              &ldquo;Pass&rdquo; mostly means &ldquo;nothing we can check fired&rdquo;. Value capture is shown only for
              the few protocols with a documented holder mechanism. Sorted by revenue; click any column to sort.
            </span>
          }
        >
          <ResearchTable rows={view.research} />
        </Panel>
      ) : view.scoresMissingReason ? (
        <Panel className="mb-4">
          <p className="text-sm text-fg-muted">{view.scoresMissingReason}</p>
        </Panel>
      ) : (
        <>
          <Panel
            padding={false}
            className="mb-4"
            title={<span className="block px-5 pt-5">Experimental: momentum ranking ({view.graded.length})</span>}
            description={
              <span className="block px-5">
                Rated assets with a full momentum history. Score B is the mean of the 3-week and 12-week momentum
                percentiles vs BTC; percentile and grade are among these assets. Setup = risk tier × momentum third.
                High risk caps the grade at C (the raw grade is shown next to it). The Phase 4 backtest found no
                predictive value for this order.
                {view.sizeCheck?.flagged && (
                  <span className="mt-1 block text-warning">
                    Size check: {Math.round((view.sizeCheck.share ?? 0) * 100)}% of the top third is {view.sizeCheck.dominant}
                    -cap. The ranking may be picking up a size effect.
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
                  Rated, but only one momentum leg exists (usually too new for 12 weeks of price history). A one-leg
                  score isn&rsquo;t comparable to a two-leg average: it lands at the extremes by construction. So these
                  are placed against the ranked distribution for reference, but never graded, tagged or ranked.
                </span>
              }
            >
              <ScreenerScoresTable rows={view.insufficientHistory} variant="insufficient" />
            </Panel>
          )}
          {view.unscoredCount > 0 && (
            <p className="mb-4 text-sm text-fg-muted">
              {view.unscoredCount} rated asset{view.unscoredCount === 1 ? " has" : "s have"} no momentum history at all and{" "}
              {view.unscoredCount === 1 ? "is" : "are"} not scored.
            </p>
          )}
        </>
      )}
    </>
  );
}

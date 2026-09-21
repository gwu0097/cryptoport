"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, RefreshCw, TrendingUp, TrendingDown, Minus, ChevronDown } from "lucide-react";
import type { TokenAnalysisRow } from "@/lib/tokenAnalysis";
import type { DirectionalNote } from "@/lib/adapters/perplexity";
import { refreshTokenAnalysis, getTokenAnalysisAction } from "@/app/(app)/watchlist/actions";
import { formatStaleness, stripCitations } from "@/lib/format";

const POLL_MS = 2500; // same cadence as useJobStatus's own DEFAULT_POLL_MS, for consistency

function ConfidencePill({ confidence }: { confidence: "high" | "medium" | "low" }) {
  const className =
    confidence === "high"
      ? "bg-positive/20 text-positive"
      : confidence === "medium"
        ? "bg-warning/20 text-warning"
        : "bg-surface-raised text-fg-muted";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${className}`}>
      {confidence} confidence
    </span>
  );
}

function DirectionIcon({ direction }: { direction: DirectionalNote["direction"] }) {
  if (direction === "building" || direction === "up") return <TrendingUp className="size-3.5 text-positive" aria-hidden="true" />;
  if (direction === "fading" || direction === "down") return <TrendingDown className="size-3.5 text-negative" aria-hidden="true" />;
  return <Minus className="size-3.5 text-fg-muted" aria-hidden="true" />;
}

const CATEGORY_LABELS: Record<string, string> = {
  unlock: "Unlock",
  listing: "Listing",
  launch: "Launch",
  partnership: "Partnership",
  governance: "Governance",
  other: "Event",
};

/** Collapsed-by-default disclosure row for the panel's denser sections —
 * reported directly as "a wall of text": Confidence/Catalysts/Bull-Bear
 * are the TL;DR shown open, everything else (momentum detail, tokenomics,
 * risks, sources) is one click away instead of all dumped open at once.
 * Same native <details>/<summary> + rotating ChevronDown pattern already
 * used for ChainGroupedHoldings' per-chain sections — just not `open` by
 * default here. */
function DisclosureRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-border py-1 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center justify-between py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted [&::-webkit-details-marker]:hidden hover:text-fg">
        {label}
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="pb-2 pt-1">{children}</div>
    </details>
  );
}

/**
 * Watchlist's on-demand, cached AI deep-dive — drafted collaboratively
 * with the user before this was built, see the prompt in
 * adapters/perplexity.ts's analyzeToken. Never runs on its own (no auto-
 * fetch on mount, no TTL-based background refresh, unlike Trend Finder's
 * explainTrend) — only a click starts it, per the direct ask "I'll decide
 * when I want it run."
 *
 * Polls getTokenAnalysisAction directly (not the shared JobPollerProvider
 * — see that action's own doc comment for why) while a refresh is in
 * flight, keeping the previous successful result visible underneath a
 * "Refreshing…" note the whole time rather than blanking the panel —
 * direct ask: "Show the last AI analysis and let me choose whether to get
 * a new one."
 *
 * No server-provided initial data — this component only ever mounts once
 * a row is actually expanded (WatchlistTable renders it conditionally,
 * same as the chart), so fetching every watchlist item's analysis row up
 * front on every page load would pay for N reads nobody's about to look
 * at. Fetches its own starting state on mount instead.
 */
export function TokenAnalysisPanel({
  coingeckoId,
  ticker,
  name,
}: {
  coingeckoId: string;
  ticker: string;
  name: string;
}) {
  const [row, setRow] = useState<TokenAnalysisRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTokenAnalysisAction(coingeckoId).then((fresh) => {
      if (!cancelled) {
        setRow(fresh);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [coingeckoId]);

  const isRefreshing = row?.status === "refreshing";

  useEffect(() => {
    if (!isRefreshing) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(async () => {
      try {
        const fresh = await getTokenAnalysisAction(coingeckoId);
        setRow(fresh);
      } catch {
        // best-effort — try again next tick
      }
    }, POLL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isRefreshing, coingeckoId]);

  async function handleRefresh() {
    setError(null);
    // Optimistic — reflects immediately instead of waiting a full poll
    // cycle to see the claim land, same "click feels instant" reasoning
    // as every job button in this app.
    setRow((prev) => ({
      status: "refreshing",
      startedAt: new Date().toISOString(),
      computedAt: prev?.computedAt ?? null,
      data: prev?.data ?? null,
    }));
    const result = await refreshTokenAnalysis(coingeckoId, ticker, name);
    if (!result.started) {
      setError(result.reason);
      const fresh = await getTokenAnalysisAction(coingeckoId);
      setRow(fresh);
    }
  }

  const data = row?.data;
  const failedLastRun = row?.status?.startsWith("error:") ?? false;

  if (!loaded) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="text-sm text-fg-muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Sparkles className="size-4 text-accent" aria-hidden="true" />
          AI analysis
        </h4>
        <div className="flex items-center gap-2">
          {data && !isRefreshing && (
            <span className="text-xs text-fg-muted">Last analyzed {formatStaleness(row!.computedAt)}</span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-fg transition hover:bg-border disabled:opacity-60"
          >
            <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            {isRefreshing ? "Analyzing…" : data ? "Refresh analysis" : "Get AI analysis"}
          </button>
        </div>
      </div>

      {isRefreshing && !data && (
        <p className="text-sm text-fg-muted">
          Searching the web for {ticker}&rsquo;s catalysts, momentum, and on-chain activity — usually takes 20-30s.
        </p>
      )}

      {error && <p className="mb-2 text-xs text-negative">{error}</p>}
      {failedLastRun && !isRefreshing && (
        <p className="mb-2 text-xs text-warning">
          The last analysis attempt failed{data ? " — showing the previous result below." : "."}
        </p>
      )}

      {data && (
        <div className={isRefreshing ? "opacity-60" : ""}>
          {/* TL;DR, always open: confidence, catalysts, bull/bear — the
              other sections below are one click away instead of all
              dumped open, per the direct ask to fix "a wall of text." */}
          <div className="mb-3">
            <ConfidencePill confidence={data.confidence} />
          </div>

          {data.catalysts.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Upcoming catalysts</p>
              <ul className="space-y-1">
                {data.catalysts.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
                      {CATEGORY_LABELS[c.category] ?? c.category}
                    </span>
                    <span className="text-fg">
                      {stripCitations(c.event)} <span className="text-fg-muted">— {stripCitations(c.timing)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-positive/30 bg-positive/5 p-2.5">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-positive">Bull case</p>
              <p className="text-sm text-fg">{stripCitations(data.bullCase)}</p>
            </div>
            <div className="rounded-lg border border-negative/30 bg-negative/5 p-2.5">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-negative">Bear case</p>
              <p className="text-sm text-fg">{stripCitations(data.bearCase)}</p>
            </div>
          </div>

          <DisclosureRow label="Social & on-chain momentum">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  <DirectionIcon direction={data.socialMomentum.direction} /> Social momentum
                </p>
                <p className="text-sm text-fg">{stripCitations(data.socialMomentum.summary)}</p>
              </div>
              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  <DirectionIcon direction={data.onchainActivity.direction} /> On-chain activity
                </p>
                <p className="text-sm text-fg">{stripCitations(data.onchainActivity.summary)}</p>
              </div>
            </div>
          </DisclosureRow>

          {(data.tokenomicsNote || data.narrativePosition) && (
            <DisclosureRow label="Tokenomics & narrative">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {data.tokenomicsNote && (
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Tokenomics</p>
                    <p className="text-sm text-fg">{stripCitations(data.tokenomicsNote)}</p>
                  </div>
                )}
                {data.narrativePosition && (
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                      Narrative position
                    </p>
                    <p className="text-sm text-fg">{stripCitations(data.narrativePosition)}</p>
                  </div>
                )}
              </div>
            </DisclosureRow>
          )}

          {data.risks.length > 0 && (
            <DisclosureRow label={`Risks (${data.risks.length})`}>
              <ul className="list-inside list-disc space-y-0.5 text-sm text-warning">
                {data.risks.map((r, i) => (
                  <li key={i}>{stripCitations(r)}</li>
                ))}
              </ul>
            </DisclosureRow>
          )}

          {data.sources.length > 0 && (
            <DisclosureRow label={`Sources (${data.sources.length})`}>
              <ul className="space-y-0.5">
                {data.sources.map((s) => (
                  <li key={s.url} className="truncate text-xs">
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            </DisclosureRow>
          )}
        </div>
      )}

      {!data && !isRefreshing && !failedLastRun && (
        <p className="text-sm text-fg-muted">
          Get a live-search read on {name}&rsquo;s catalysts, momentum, on-chain activity, and a balanced bull/bear
          case — not a recommendation, just context for your own call.
        </p>
      )}
    </div>
  );
}

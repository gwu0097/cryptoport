"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { TrendExplanationRow } from "@/lib/trendPeers";
import { refreshTrendExplanation, getTrendExplanationAction } from "@/app/(app)/trend-finder/actions";
import { formatStaleness } from "@/lib/format";

const POLL_MS = 2500; // same cadence as TokenAnalysisPanel's own poll

/**
 * The "Why is this moving" panel's on-demand refresh control — mirrors
 * TokenAnalysisPanel.tsx's exact mechanism (CAS-claim Server Action +
 * after(), poll while refreshing, keep the last result visible the whole
 * time), applied to trend_explanations instead of token_analyses. Direct
 * ask: "let's have a button just like ai analysis to refresh the trend
 * finder and show a last scanned time."
 *
 * Unlike TokenAnalysisPanel, this doesn't own the actual explanation
 * content — TrendAnalysisSection (a Server Component) renders that part
 * itself from the page's own server-fetched `explanation` prop, so a
 * completed refresh calls `router.refresh()` to re-run that server render
 * with the new row rather than duplicating the content here. This island
 * only owns the button, the "last scanned" caption, and the in-flight
 * status note.
 *
 * `initialRow` only seeds `useState` (not synced via an effect) — that's
 * safe because a different seed always means a different `id`/`mcapFloor`
 * on the page's own keyed `<Suspense>` (see trend-finder/page.tsx), which
 * unmounts and remounts this entire subtree fresh rather than re-rendering
 * it in place, so there's never a stale `row` left over from a previous
 * token to reset.
 */
export function TrendExplanationRefresh({
  seedId,
  symbol,
  name,
  initialRow,
}: {
  seedId: string;
  symbol: string;
  name: string;
  initialRow: TrendExplanationRow;
}) {
  const router = useRouter();
  const [row, setRow] = useState(initialRow);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRefreshing = row.status === "refreshing";

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
        const fresh = await getTrendExplanationAction(seedId);
        setRow(fresh);
        // A busy->done transition means the server-rendered content below
        // (summary/tags/sources, and the peer tables that depend on the
        // AI's categoryGuess/aiTickers) is now stale — re-run the page's
        // server render to pick up the new row, same as any other job
        // completion in this app.
        if (fresh.status !== "refreshing") router.refresh();
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
  }, [isRefreshing, seedId, router]);

  async function handleRefresh() {
    setError(null);
    // Optimistic — reflects immediately instead of waiting a full poll
    // cycle to see the claim land.
    setRow((prev) => ({
      status: "refreshing",
      startedAt: new Date().toISOString(),
      computedAt: prev.computedAt,
      data: prev.data,
    }));
    const result = await refreshTrendExplanation(seedId, symbol, name);
    if (!result.started) {
      setError(result.reason);
      const fresh = await getTrendExplanationAction(seedId);
      setRow(fresh);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {row.data && !isRefreshing && (
        <span className="text-xs font-normal text-fg-muted">Last scanned {formatStaleness(row.computedAt)}</span>
      )}
      {error && <span className="text-xs font-normal text-negative">{error}</span>}
      <button
        type="button"
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-fg transition hover:bg-border disabled:opacity-60"
      >
        <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
        {isRefreshing ? "Scanning…" : row.data ? "Refresh" : "Scan"}
      </button>
    </div>
  );
}

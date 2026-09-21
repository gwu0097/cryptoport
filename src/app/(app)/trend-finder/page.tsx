import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TrendSeedPicker } from "@/components/TrendSeedPicker";
import { TrendRecentSearches } from "@/components/TrendRecentSearches";
import { TrendLastSearchRedirect } from "@/components/TrendLastSearchRedirect";
import { TrendAnalysisSection } from "@/components/TrendAnalysisSection";
import { searchCoins } from "@/lib/adapters/coingecko";
import { pickBestMatch } from "@/lib/watchlistInput";

export const dynamic = "force-dynamic";
// A cold cache (no trend_explanations hit yet for this seed) makes one live
// Perplexity Agent API call (a real web-search round trip, observed taking
// up to ~20-30s) plus CoinGecko category/market lookups — same order of
// magnitude as lookup/page.tsx's own maxDuration for a comparable reason.
export const maxDuration = 300;
export const metadata = { title: "Trend finder · CryptoPort" };

const DEFAULT_MCAP_FLOOR = 200_000_000;

// loading.tsx's Suspense boundary is keyed without search params (see
// node_modules/next/dist/client/components/layout-router.js), so it only
// shows a fallback on a genuine first visit to /trend-finder — clicking
// the market-cap-floor picker, or searching a new token while results are
// already shown, only changes `id`/`ticker`/`mcap` on this same segment,
// which resumes inside an already-resolved boundary and shows no loading
// feedback at all. This local, keyed Suspense fixes it: a key change
// forces a brand-new boundary, which does show its fallback mid-
// transition. See encyclopedia/page.tsx's TabFallback for the same fix
// applied to its tab pills.
function TrendResultsFallback() {
  return (
    <Panel className="flex flex-col items-center gap-3 py-12 text-center">
      <Loader2 className="size-6 animate-spin text-accent" aria-hidden="true" />
      <p className="text-sm text-fg-muted">Looking up sector peers — a first-time token can take a few seconds…</p>
    </Panel>
  );
}

export default async function TrendFinderPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; ticker?: string; mcap?: string }>;
}) {
  const { id, ticker, mcap } = await searchParams;
  const mcapFloor = mcap !== undefined && !Number.isNaN(Number(mcap)) ? Number(mcap) : DEFAULT_MCAP_FLOOR;

  return (
    <>
      <PageHeader
        title="Trend finder"
        subtitle="Pick a token that already moved — see why, and what else shares that narrative."
      />

      {/* Always rendered, not just in the empty state — the nav link back
          to this page always lands on the bare route (same convention as
          Wallets/Analytics/Transactions' own top nav item), so this is
          what makes "switch tabs, come back" actually recoverable rather
          than starting over from a blank picker every time. */}
      <TrendRecentSearches />

      {id ? (
        <Suspense key={`id:${id}:${mcapFloor}`} fallback={<TrendResultsFallback />}>
          <TrendAnalysisSection id={id} mcapFloor={mcapFloor} basePath="/trend-finder" />
        </Suspense>
      ) : ticker ? (
        <Suspense key={`ticker:${ticker}:${mcapFloor}`} fallback={<TrendResultsFallback />}>
          <TrendResultsFromTicker ticker={ticker} mcapFloor={mcapFloor} />
        </Suspense>
      ) : (
        <>
          {/* Only mounted here (never on a real result) — redirects to the
              most recently searched token if one exists, so this bare
              empty state is only ever actually seen on a genuinely first
              visit with no history yet. */}
          <TrendLastSearchRedirect />
          <Panel className="text-center">
            <p className="mb-4 text-sm text-fg-muted">
              Search for a token to find out why it&rsquo;s moving and what else shares that narrative.
            </p>
            <div className="mx-auto max-w-sm text-left">
              <TrendSeedPicker />
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

/**
 * The Dashboard's Holdings mover rows have no stored CoinGecko id (an
 * AssetGroup is ticker-grouped across chains/contracts, and native tickers
 * like BTC/ETH/SOL aren't in token_registry at all — see the plan's own
 * note on why this is real work, not a one-liner), so their "Find Trend"
 * link carries a bare ?ticker= instead of ?id=. Resolved best-effort with
 * the same searchCoins()+pickBestMatch() pair Watchlist's bulk-add already
 * trusts (exact-symbol match first, lowest market-cap rank as the
 * tiebreak) — deliberately NOT the default path (the on-page picker and
 * Watchlist mover links always carry a real id), and the result panel says
 * plainly that it matched from a ticker so a symbol collision is visible,
 * never silent. See CLAUDE.md's Data Correctness section on the real
 * spoofed-ticker incident this app has already had.
 */
async function TrendResultsFromTicker({ ticker, mcapFloor }: { ticker: string; mcapFloor: number }) {
  const candidates = await searchCoins(ticker);
  const match = pickBestMatch(ticker, candidates);

  if (!match) {
    return (
      <Panel className="text-center">
        <p className="mb-4 text-sm text-fg-muted">
          No CoinGecko match for ticker &ldquo;{ticker}&rdquo; — try searching directly instead.
        </p>
        <div className="mx-auto max-w-sm text-left">
          <TrendSeedPicker />
        </div>
      </Panel>
    );
  }

  return <TrendAnalysisSection id={match.id} mcapFloor={mcapFloor} matchedFromTicker={ticker} basePath="/trend-finder" />;
}

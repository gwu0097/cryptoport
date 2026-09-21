import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TokenIcon } from "@/components/TokenIcon";
import { TrendSeedPicker } from "@/components/TrendSeedPicker";
import { TrendPeerTable } from "@/components/TrendPeerTable";
import { TrendRecentSearches } from "@/components/TrendRecentSearches";
import { TrendLastSearchRedirect } from "@/components/TrendLastSearchRedirect";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";
import { formatUsd, formatPercent } from "@/lib/format";
import { findTrendPeers } from "@/lib/trendPeers";
import { searchCoins, type SeedInfo } from "@/lib/adapters/coingecko";
import type { PeerRow } from "@/lib/trendFinder";
import { pickBestMatch } from "@/lib/watchlistInput";

export const dynamic = "force-dynamic";
// A cold cache (no trend_explanations hit yet for this seed) makes one live
// Perplexity Agent API call (a real web-search round trip, observed taking
// up to ~20-30s) plus CoinGecko category/market lookups — same order of
// magnitude as lookup/page.tsx's own maxDuration for a comparable reason.
export const maxDuration = 300;
export const metadata = { title: "Trend finder · CryptoPort" };

const DEFAULT_MCAP_FLOOR = 200_000_000;
const MCAP_PRESETS = [
  { value: 50_000_000, label: "$50M+" },
  { value: 200_000_000, label: "$200M+" },
  { value: 500_000_000, label: "$500M+" },
  { value: 1_000_000_000, label: "$1B+" },
  { value: 0, label: "Any" },
];

function ChangeCell({ value }: { value: number | null }) {
  const className =
    value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} tabular-nums`}>{formatPercent(value)}</span>;
}

/** Server-rendered preset links, no client JS — same searchParams-driven
 * filtering pattern as CheckboxLink, just not boolean-shaped so a plain
 * pill row of links fits better than a disguised checkbox. */
function McapFloorPicker({ id, mcapFloor }: { id: string; mcapFloor: number }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-border p-0.5">
      {MCAP_PRESETS.map((preset) => {
        const active = preset.value === mcapFloor;
        return (
          <Link
            key={preset.value}
            href={`/trend-finder?id=${encodeURIComponent(id)}&mcap=${preset.value}`}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              active ? "bg-accent text-white" : "text-fg-muted hover:text-fg"
            }`}
          >
            {preset.label}
          </Link>
        );
      })}
    </div>
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
        <TrendResults id={id} mcapFloor={mcapFloor} />
      ) : ticker ? (
        <TrendResultsFromTicker ticker={ticker} mcapFloor={mcapFloor} />
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
 * the same searchCoins()+pickBestMatch() this app already trusts for
 * Watchlist's bulk-add (exact-symbol match first, lowest market-cap rank
 * as the tiebreak) — deliberately NOT the default path (the on-page
 * picker and Watchlist mover links always carry a real id), and the
 * result panel says plainly that it matched from a ticker so a symbol
 * collision is visible, never silent. See CLAUDE.md's Data Correctness
 * section on the real spoofed-ticker incident this app has already had.
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

  return <TrendResults id={match.id} mcapFloor={mcapFloor} matchedFromTicker={ticker} />;
}

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

async function TrendResults({
  id,
  mcapFloor,
  matchedFromTicker,
}: {
  id: string;
  mcapFloor: number;
  matchedFromTicker?: string;
}) {
  const result = await findTrendPeers({ coingeckoId: id, mcapFloor });

  if (result.status === "no-seed-data") {
    return (
      <Panel className="text-center">
        <p className="text-sm text-negative">
          CoinGecko has no market data for &ldquo;{result.seedId}&rdquo; — try a different token.
        </p>
      </Panel>
    );
  }

  const { seed, explanation, category, categoryPeers, aiPeers } = result;
  const categoryRows = peerRowsWithSeed(seed, categoryPeers);
  const aiRows = peerRowsWithSeed(seed, aiPeers);
  const confirmedIds = intersectIds(categoryPeers, aiPeers);

  return (
    <>
      {/* Recorded once a seed actually resolves — including the ticker-
          fallback path (matchedFromTicker), so a recent chip always
          carries the real, unambiguous id, never a bare ticker string
          that would need re-resolving on the next click. */}
      <RecordRecentWallet id={seed.id} name={seed.symbol} namespace="trendFinderSearches" maxRecent={5} />
      <Panel className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <TokenIcon ticker={seed.symbol} url={seed.imageUrl} />
            <div>
              <p className="flex items-center gap-1.5 text-lg font-semibold text-fg">
                {seed.name} <span className="text-fg-muted">({seed.symbol})</span>
                <a
                  href={`https://www.coingecko.com/en/coins/${seed.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on CoinGecko"
                  aria-label={`View ${seed.symbol} on CoinGecko`}
                  className="text-fg-muted transition hover:text-accent"
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </p>
              <p className="text-xs text-fg-muted">
                {seed.marketCapRank !== null ? `Rank #${seed.marketCapRank}` : "Unranked"} ·{" "}
                {seed.price !== null ? formatUsd(seed.price) : "—"} · 24h <ChangeCell value={seed.change24h} />
              </p>
              {matchedFromTicker && (
                <p className="mt-0.5 text-xs text-warning">Matched from ticker &ldquo;{matchedFromTicker}&rdquo;</p>
              )}
            </div>
          </div>
          <div className="mx-auto w-full max-w-sm sm:mx-0 sm:w-auto">
            <TrendSeedPicker mcap={String(mcapFloor)} />
          </div>
        </div>
        <div className="mt-4">
          <McapFloorPicker id={id} mcapFloor={mcapFloor} />
        </div>
      </Panel>

      <Panel className="mb-6" title="Why is this moving">
        {explanation ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ConfidencePill confidence={explanation.confidence} />
              {explanation.narrativeTags.map((tag) => (
                <span key={tag} className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                  {tag}
                </span>
              ))}
            </div>
            <p className="text-sm text-fg">{explanation.reasonSummary}</p>
            {explanation.sources.length > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <p className="mb-1 text-xs font-medium text-fg-muted">Sources — for your own DD:</p>
                <ul className="space-y-0.5">
                  {explanation.sources.map((s) => (
                    <li key={s.url} className="truncate text-xs">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {s.title || s.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            Couldn&rsquo;t determine a reason right now — the AI lookup failed or timed out. Category peers below may
            still be useful.
          </p>
        )}
      </Panel>

      <Panel
        className="mb-6"
        title={category ? `CoinGecko category: ${category.name}` : "CoinGecko category"}
        description="Verified category membership — no AI involved in this list"
      >
        {categoryPeers.length > 0 ? (
          <TrendPeerTable peers={categoryRows} seedId={seed.id} confirmedIds={confirmedIds} />
        ) : (
          <p className="text-sm text-fg-muted">
            {category
              ? `No other members above the market cap floor — try a lower one above.`
              : `No confident CoinGecko category match for this narrative.`}
          </p>
        )}
      </Panel>

      <Panel
        className="mb-2"
        title="AI-suggested peers"
        description="Named by a live news search as moving for a similar reason — not a verified list"
      >
        {aiPeers.length > 0 ? (
          <TrendPeerTable peers={aiRows} seedId={seed.id} confirmedIds={confirmedIds} />
        ) : (
          <p className="text-sm text-fg-muted">
            {explanation
              ? "No AI-suggested tickers resolved to a real, confident CoinGecko match above the market cap floor."
              : "Unavailable — the AI lookup failed or timed out."}
          </p>
        )}
      </Panel>

      <p className="mt-2 text-xs text-fg-muted">
        Peers come from two independent sources: CoinGecko&rsquo;s category taxonomy, and a live AI news search naming
        other tokens moving for a similar reason — a coin in both is flagged &ldquo;Confirmed by both.&rdquo; This is a
        starting point for your own research, not a verified signal — read the sources above before acting on
        anything here. The AI lookup is recomputed at most once a day per token; market data is live as of this page
        load.
      </p>
    </>
  );
}

/** The seed's own info (already fetched for the summary panel above),
 * prepended to each ranked table as its own row — the direct ask: seeing
 * e.g. KMNO itself ranked alongside its peers tells you something the
 * summary panel alone doesn't. Omitted when the seed itself has no market
 * cap (rare) — never fabricated, just left out, same as any other
 * missing-data case in this app. Shown regardless of the market-cap floor
 * — that filters peers, not the token you actually searched for. */
function peerRowsWithSeed(seed: SeedInfo, peers: PeerRow[]): PeerRow[] {
  if (seed.marketCap === null) return peers;
  const seedRow: PeerRow = {
    id: seed.id,
    symbol: seed.symbol,
    imageUrl: seed.imageUrl,
    price: seed.price,
    change1h: seed.change1h,
    change24h: seed.change24h,
    change7d: seed.change7d,
    marketCap: seed.marketCap,
  };
  return [seedRow, ...peers];
}

/** Ids present in both peer sources — what TrendPeerTable's "Confirmed by
 * both" badge is keyed on (see the direct ask: "see if there's overlap and
 * what isn't" between the CoinGecko-category and AI-suggested lists). */
function intersectIds(a: PeerRow[], b: PeerRow[]): Set<string> {
  const bIds = new Set(b.map((p) => p.id));
  return new Set(a.filter((p) => bIds.has(p.id)).map((p) => p.id));
}

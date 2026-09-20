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
import { formatUsd, formatCompactUsd, formatPercent } from "@/lib/format";
import { findTrendPeers } from "@/lib/trendPeers";
import { searchCoins, type SeedInfo } from "@/lib/adapters/coingecko";
import type { CorrelatedPeer } from "@/lib/trendFinder";
import { pickBestMatch } from "@/lib/watchlistInput";

export const dynamic = "force-dynamic";
// A cold cache (no coin_correlations hit yet for this seed) computes
// correlation against the full ~250-coin universe plus one live
// fetchTopCoinsByMarketCap call for display data — same order of magnitude
// as lookup/page.tsx's own maxDuration for a comparable reason.
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
        subtitle="Pick a token that already moved — see correlated peers that haven't yet."
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
              Search for a token to find peers that historically move with it and haven&rsquo;t moved as much yet.
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

  const { seed } = result;

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

      {result.status === "no-peers" ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">
            No peers found for {seed.symbol} — nothing in the current universe has historically moved with it closely
            enough{mcapFloor > 0 ? ` above ${formatCompactUsd(mcapFloor)}` : ""} to call a real peer. Try a lower
            market cap floor, or this token&rsquo;s move may genuinely be idiosyncratic to it.
          </p>
        </Panel>
      ) : (
        <>
          <Panel
            title="Correlated peers"
            description="90d hourly returns, with broad market moves (BTC/ETH) factored out"
          >
            <TrendPeerTable peers={peerRowsWithSeed(seed, result.peers)} seedId={seed.id} />
          </Panel>
          <p className="mt-2 text-xs text-fg-muted">
            Peers are ranked by how closely their price has historically tracked {seed.symbol}&rsquo;s, once broad
            market moves are factored out — a token can be a real peer without sharing a CoinGecko category, and a
            shared category is no longer what determines this list. Market data is live as of this page load;
            correlation is recomputed at most once a day.
          </p>
        </>
      )}
    </>
  );
}

/** The seed's own info (already fetched for the summary panel above),
 * prepended to the ranked table as its own row — the direct ask: seeing
 * e.g. AVAX itself ranked alongside its peers tells you something the
 * summary panel alone doesn't (is the seed the biggest mover among its own
 * peers, or the laggard everyone else already left behind?). Correlation
 * is fixed at 1 (a token is, trivially, perfectly correlated with itself)
 * rather than computed — it's never passed back through rankPeers, so this
 * never risks being dropped by the correlation/overlap thresholds. Omitted
 * when the seed itself has no market cap (rare) — never fabricated, just
 * left out, same as any other missing-data case in this app. Shown
 * regardless of the market-cap floor — that filters peers, not the token
 * you actually searched for. */
function peerRowsWithSeed(seed: SeedInfo, peers: CorrelatedPeer[]): CorrelatedPeer[] {
  if (seed.marketCap === null) return peers;
  const seedRow: CorrelatedPeer = {
    id: seed.id,
    symbol: seed.symbol,
    imageUrl: seed.imageUrl,
    price: seed.price,
    change1h: seed.change1h,
    change24h: seed.change24h,
    change7d: seed.change7d,
    marketCap: seed.marketCap,
    correlation: 1,
    overlapHours: 0,
  };
  return [seedRow, ...peers];
}

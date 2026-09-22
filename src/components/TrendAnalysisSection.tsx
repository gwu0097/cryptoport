import Link from "next/link";
import { ExternalLink, BookOpen } from "lucide-react";
import { Panel } from "./ui/Panel";
import { TokenIcon } from "./TokenIcon";
import { TrendSeedPicker } from "./TrendSeedPicker";
import { TrendPeerTable } from "./TrendPeerTable";
import { RecordRecentWallet } from "./RecordRecentWallet";
import { TrendExplanationRefresh } from "./TrendExplanationRefresh";
import { formatUsd, formatPercent, stripCitations } from "@/lib/format";
import { findTrendPeers } from "@/lib/trendPeers";
import type { PeerRow } from "@/lib/trendFinder";
import type { SeedInfo } from "@/lib/adapters/coingecko";
import { getUser } from "@/lib/auth";
import { getWatchlists } from "@/lib/queries";

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

/** Server-rendered preset links, no client JS — same searchParams-driven
 * filtering pattern as CheckboxLink, just not boolean-shaped so a plain
 * pill row of links fits better than a disguised checkbox. `basePath`/
 * `extraQuery` are what let this same picker live on two different routes
 * (Trend Finder's own page, and Encyclopedia's Trend tab) without either
 * one losing its own URL shape — Encyclopedia needs `tab=trend` to survive
 * a market-cap-floor click, Trend Finder doesn't have a `tab` param at
 * all. */
function McapFloorPicker({
  id,
  mcapFloor,
  basePath,
  extraQuery,
}: {
  id: string;
  mcapFloor: number;
  basePath: string;
  extraQuery?: string;
}) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-border p-0.5">
      {MCAP_PRESETS.map((preset) => {
        const active = preset.value === mcapFloor;
        return (
          <Link
            key={preset.value}
            href={`${basePath}?id=${encodeURIComponent(id)}&mcap=${preset.value}${extraQuery ? `&${extraQuery}` : ""}`}
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
    name: seed.name,
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

/**
 * The full "why is this moving + category peers + AI-suggested peers"
 * render — extracted from trend-finder/page.tsx's own former TrendResults
 * once Encyclopedia needed the identical block a second time (its own
 * "Trend Finder" tab). Both callers get the exact same logic/caching
 * (findTrendPeers, unchanged) — this is purely a "expose it in a second
 * place" reuse, not a fork, so a fix to either one automatically applies
 * to both.
 *
 * `basePath`/`extraQuery` let McapFloorPicker/TrendSeedPicker build the
 * right URL for whichever route is rendering this. `showSeedPicker`
 * suppresses the inline "search again" box for Encyclopedia, which
 * already has its own persistent top-level search — showing both would
 * be a redundant second search box scoped confusingly differently (one
 * re-searches within just this tab, the other resets the whole page).
 */
export async function TrendAnalysisSection({
  id,
  mcapFloor,
  matchedFromTicker,
  basePath,
  extraQuery,
  showHeader = true,
}: {
  id: string;
  mcapFloor: number;
  matchedFromTicker?: string;
  basePath: string;
  extraQuery?: string;
  /** Suppresses the icon/name/price identity block and its embedded
   * re-search box — Encyclopedia already renders its own version of that,
   * shared across all its tabs, so showing it a second time here would be
   * a redundant duplicate. The market-cap-floor picker below it stays
   * regardless — that's real, tab-specific filtering, not identity. */
  showHeader?: boolean;
}) {
  const [result, user] = await Promise.all([findTrendPeers({ coingeckoId: id, mcapFloor }), getUser()]);
  const watchlists = user ? await getWatchlists() : null;

  if (result.status === "no-seed-data") {
    return (
      <Panel className="text-center">
        <p className="text-sm text-negative">
          CoinGecko has no market data for &ldquo;{result.seedId}&rdquo; — try a different token.
        </p>
      </Panel>
    );
  }

  const {
    seed,
    explanation,
    anchorCategoryNames,
    categories,
    categoryCheck,
    categoryPeers,
    aiPeers,
    aiOtherCategory,
    aiPeerReasons,
  } = result;
  const explanationData = explanation.data;
  const categoryRows = peerRowsWithSeed(seed, categoryPeers);
  const aiRows = peerRowsWithSeed(seed, aiPeers);
  const aiOtherRows = peerRowsWithSeed(seed, aiOtherCategory);
  const categoryLabel = categories.map((c) => c.name).join(" · ");
  const confirmedIds = intersectIds(categoryPeers, aiPeers);

  return (
    <>
      {/* Recorded once a seed actually resolves — including the ticker-
          fallback path (matchedFromTicker), so a recent chip always
          carries the real, unambiguous id, never a bare ticker string
          that would need re-resolving on the next click. */}
      <RecordRecentWallet id={seed.id} name={seed.symbol} namespace="trendFinderSearches" maxRecent={5} />
      {showHeader && (
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
                  <Link
                    href={`/encyclopedia?id=${encodeURIComponent(seed.id)}`}
                    title="Open in Encyclopedia"
                    aria-label={`Open ${seed.symbol} in Encyclopedia`}
                    className="text-fg-muted transition hover:text-accent"
                  >
                    <BookOpen className="size-4" aria-hidden="true" />
                  </Link>
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
        </Panel>
      )}

      <div className="mb-6">
        <McapFloorPicker id={id} mcapFloor={mcapFloor} basePath={basePath} extraQuery={extraQuery} />
      </div>

      <Panel
        className="mb-6"
        title={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Why is this moving</span>
            <TrendExplanationRefresh seedId={seed.id} symbol={seed.symbol} name={seed.name} initialRow={explanation} />
          </div>
        }
      >
        {explanationData ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ConfidencePill confidence={explanationData.confidence} />
              {explanationData.narrativeTags.map((tag) => (
                <span key={tag} className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                  {tag}
                </span>
              ))}
            </div>
            <p className="text-sm text-fg">{stripCitations(explanationData.reasonSummary)}</p>
            {explanationData.sources.length > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <p className="mb-1 text-xs font-medium text-fg-muted">Sources — for your own DD:</p>
                <ul className="space-y-0.5">
                  {explanationData.sources.map((s) => (
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
            {explanation.status === "refreshing"
              ? "Scanning the web for why this is moving — usually takes 20-30s."
              : explanation.status?.startsWith("error:")
                ? "The last scan failed — click Refresh above to try again. Category peers below may still be useful."
                : "No scan yet for this token — click Scan above to search the web for why it's moving."}
          </p>
        )}
      </Panel>

      <Panel
        className="mb-6"
        title={categories.length > 0 ? `Same category: ${categoryLabel}` : "Same category"}
        description={`${seed.symbol}'s own CoinGecko categories, keeping only ones about what it does (chain-ecosystem, investor, index and listing tags are ignored). No AI involved in this list. Click the arrow on a row to overlay its chart.`}
      >
        {categoryPeers.length > 0 ? (
          <TrendPeerTable
            peers={categoryRows}
            seedId={seed.id}
            seedSymbol={seed.symbol}
            confirmedIds={confirmedIds}
            watchlists={watchlists}
          />
        ) : (
          <p className="text-sm text-fg-muted">
            {categories.length > 0
              ? "No other members above the market cap floor — try a lower one above."
              : anchorCategoryNames.length > 0
                ? `CoinGecko lists ${seed.symbol} under ${anchorCategoryNames.join(", ")}, but none of those matched a category with a member list.`
                : `CoinGecko gives ${seed.symbol} no functional category (only chain, investor or index tags), so there's no category to compare against.`}
          </p>
        )}
      </Panel>

      <Panel
        className="mb-2"
        title="AI-suggested peers"
        description={
          categoryCheck
            ? `Named by a live news search, kept only if they share a category above with ${seed.symbol} (checked against CoinGecko, not the AI's word). Click the arrow on a row for why and an overlaid chart.`
            : `Named by a live news search — NOT category-checked (${seed.symbol}'s CoinGecko categories couldn't be determined). Click the arrow on a row for why and an overlaid chart.`
        }
      >
        {aiPeers.length > 0 ? (
          <TrendPeerTable
            peers={aiRows}
            seedId={seed.id}
            seedSymbol={seed.symbol}
            confirmedIds={confirmedIds}
            reasons={aiPeerReasons}
            watchlists={watchlists}
          />
        ) : (
          <p className="text-sm text-fg-muted">
            {explanationData
              ? categoryCheck
                ? `None of the AI's suggestions share a functional category with ${seed.symbol} above the market cap floor.`
                : "No AI-suggested tickers resolved to a real, confident CoinGecko match above the market cap floor."
              : "Unavailable — scan above to search the web for why this is moving."}
          </p>
        )}
        {aiOtherCategory.length > 0 && (
          <details className="mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg">
              In the same news, different category — not peers ({aiOtherCategory.length})
            </summary>
            <p className="mt-2 mb-3 text-xs text-fg-muted">
              Named by the news search but outside {seed.symbol}&rsquo;s categories — e.g. other partners in the same
              launch. Shown for context only.
            </p>
            <TrendPeerTable
              peers={aiOtherRows}
              seedId={seed.id}
              seedSymbol={seed.symbol}
              reasons={aiPeerReasons}
              watchlists={watchlists}
            />
          </details>
        )}
      </Panel>

      <p className="mt-2 text-xs text-fg-muted">
        Peers must share a functional CoinGecko category with the searched token. They come from two sources: that
        category&rsquo;s members, and a live AI news search (kept only if it passes the same category check) — a coin
        in both is flagged &ldquo;Confirmed by both.&rdquo; This is a
        starting point for your own research, not a verified signal — read the sources above before acting on
        anything here. The AI lookup runs only when someone clicks Scan/Refresh above, then stays cached for everyone
        until the next click; market data is live as of this page load.
      </p>
    </>
  );
}

import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TokenIcon } from "@/components/TokenIcon";
import { TrendSeedPicker } from "@/components/TrendSeedPicker";
import { TrendAnalysisSection } from "@/components/TrendAnalysisSection";
import { TradingViewCompareChart } from "@/components/TradingViewCompareChart";
import { TokenAnalysisPanel } from "@/components/watchlist/TokenAnalysisPanel";
import { EncyclopediaRecentSearches } from "@/components/EncyclopediaRecentSearches";
import { EncyclopediaLastSearchRedirect } from "@/components/EncyclopediaLastSearchRedirect";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";
import { formatUsd, formatPercent } from "@/lib/format";
import { fetchSeedInfo, searchCoins } from "@/lib/adapters/coingecko";
import { pickBestMatch } from "@/lib/watchlistInput";

export const dynamic = "force-dynamic";
// The Trend Finder tab can make a fresh Perplexity Agent call (~20-30s) —
// same reasoning as trend-finder/page.tsx's own maxDuration.
export const maxDuration = 300;
export const metadata = { title: "Encyclopedia · CryptoPort" };

const DEFAULT_MCAP_FLOOR = 200_000_000;
const TABS = [
  { key: "chart", label: "Chart" },
  { key: "trend", label: "Trend Finder" },
  { key: "ai", label: "AI Analysis" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function ChangeText({ value }: { value: number | null }) {
  const className =
    value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={className}>{formatPercent(value)}</span>;
}

/**
 * One-stop research page for any token — reported directly: "everything
 * we build around any token, the encyclopedia is where we'd be able to
 * see all the research." Deliberately thin: every tab reuses an existing,
 * already-shipped piece as-is (TrendAnalysisSection, TradingViewCompareChart,
 * TokenAnalysisPanel) rather than a new render for each — the direct
 * assumption ("everything shares the same data from the same tables,
 * we're just exposing it in different places") holds because the
 * underlying caches (trend_explanations, token_analyses) were both built
 * globally/coingecko_id-keyed from the start, not scoped to the page that
 * happened to trigger them first.
 *
 * Search works for ANY real CoinGecko-listed token, including ones this
 * app has never seen before — TrendSeedPicker's own live /search call was
 * never scoped to "tokens with existing data," so this needed no change
 * to support that. Each tab computes/fetches its own content lazily (only
 * once actually selected — a real navigation for Chart/Trend Finder via
 * the tab links below, an on-mount fetch for AI Analysis, which was
 * already built that way for Watchlist), never all three at once.
 */
export default async function EncyclopediaPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; ticker?: string; tab?: string; mcap?: string }>;
}) {
  const { id, ticker, tab: tabParam, mcap } = await searchParams;
  const tab: Tab = tabParam === "trend" || tabParam === "ai" ? tabParam : "chart";
  const mcapFloor = mcap !== undefined && !Number.isNaN(Number(mcap)) ? Number(mcap) : DEFAULT_MCAP_FLOOR;

  return (
    <>
      <PageHeader
        title="Encyclopedia"
        subtitle="Search any token — chart, trend analysis, and AI research, all in one place."
      />

      <EncyclopediaRecentSearches />

      {id ? (
        <EncyclopediaResults id={id} tab={tab} mcapFloor={mcapFloor} />
      ) : ticker ? (
        <EncyclopediaResultsFromTicker ticker={ticker} tab={tab} mcapFloor={mcapFloor} />
      ) : (
        <>
          {/* Only mounted on the bare, param-less landing state — same
              "redirect to last search, but only when there's genuinely
              nothing else to show" convention as Trend Finder's own. */}
          <EncyclopediaLastSearchRedirect />
          <Panel className="text-center">
            <p className="mb-4 text-sm text-fg-muted">
              Search for any token — even one you&rsquo;ve never held or watched — to see its chart, trend analysis,
              and AI research in one place.
            </p>
            <div className="mx-auto max-w-sm text-left">
              <TrendSeedPicker basePath="/encyclopedia" />
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

/** Same ?ticker= fallback as Trend Finder's own TrendResultsFromTicker —
 * needed for exactly the same reason: several call sites linking here
 * (AssetsTable, Dashboard's MoverList) only ever have a bare ticker, not a
 * real CoinGecko id (an AssetGroup is ticker-grouped across chains/
 * contracts with no stored id). Resolved via the same searchCoins()+
 * pickBestMatch() pair, never guessed — see that function's own doc
 * comment on the real spoofed-ticker incident this app's Data Correctness
 * rule exists because of. */
async function EncyclopediaResultsFromTicker({ ticker, tab, mcapFloor }: { ticker: string; tab: Tab; mcapFloor: number }) {
  const candidates = await searchCoins(ticker);
  const match = pickBestMatch(ticker, candidates);

  if (!match) {
    return (
      <Panel className="text-center">
        <p className="mb-4 text-sm text-fg-muted">
          No CoinGecko match for ticker &ldquo;{ticker}&rdquo; — try searching directly instead.
        </p>
        <div className="mx-auto max-w-sm text-left">
          <TrendSeedPicker basePath="/encyclopedia" />
        </div>
      </Panel>
    );
  }

  return <EncyclopediaResults id={match.id} tab={tab} mcapFloor={mcapFloor} matchedFromTicker={ticker} />;
}

async function EncyclopediaResults({
  id,
  tab,
  mcapFloor,
  matchedFromTicker,
}: {
  id: string;
  tab: Tab;
  mcapFloor: number;
  matchedFromTicker?: string;
}) {
  const seed = await fetchSeedInfo(id);
  if (!seed) {
    return (
      <Panel className="text-center">
        <p className="text-sm text-negative">
          CoinGecko has no market data for &ldquo;{id}&rdquo; — try a different token.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <RecordRecentWallet id={seed.id} name={seed.symbol} namespace="encyclopediaSearches" maxRecent={5} />

      <Panel className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <TokenIcon ticker={seed.symbol} url={seed.imageUrl} />
            <div>
              <p className="text-lg font-semibold text-fg">
                {seed.name} <span className="text-fg-muted">({seed.symbol})</span>
              </p>
              <p className="text-xs text-fg-muted">
                {seed.marketCapRank !== null ? `Rank #${seed.marketCapRank}` : "Unranked"} ·{" "}
                {seed.price !== null ? formatUsd(seed.price) : "—"} · 24h <ChangeText value={seed.change24h} />
              </p>
              {matchedFromTicker && (
                <p className="mt-0.5 text-xs text-warning">Matched from ticker &ldquo;{matchedFromTicker}&rdquo;</p>
              )}
            </div>
          </div>
          <div className="mx-auto w-full max-w-sm sm:mx-0 sm:w-auto">
            <TrendSeedPicker basePath="/encyclopedia" />
          </div>
        </div>
      </Panel>

      <div className="mb-4 inline-flex flex-wrap rounded-lg border border-border p-0.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/encyclopedia?id=${encodeURIComponent(id)}&tab=${t.key}`}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              tab === t.key ? "bg-accent text-white" : "text-fg-muted hover:text-fg"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "chart" && <TradingViewCompareChart baseTicker={seed.symbol} compareTicker="BTC" />}

      {tab === "trend" && (
        <TrendAnalysisSection
          id={id}
          mcapFloor={mcapFloor}
          basePath="/encyclopedia"
          extraQuery="tab=trend"
          showHeader={false}
        />
      )}

      {tab === "ai" && <TokenAnalysisPanel coingeckoId={seed.id} ticker={seed.symbol} name={seed.name} />}
    </>
  );
}

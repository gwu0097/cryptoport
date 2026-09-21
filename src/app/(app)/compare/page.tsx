import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TokenIcon } from "@/components/TokenIcon";
import { TradingViewCompareChart } from "@/components/TradingViewCompareChart";
import { CompareCoinPicker } from "@/components/CompareCoinPicker";
import { CompareRecentSearches } from "@/components/CompareRecentSearches";
import { CompareLastSearchRedirect } from "@/components/CompareLastSearchRedirect";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";
import { fetchSeedInfo, type SeedInfo } from "@/lib/adapters/coingecko";
import { formatUsd, formatPercent } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare · CryptoPort" };

function ChangeCell({ value }: { value: number | null }) {
  const className =
    value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} tabular-nums`}>{formatPercent(value)}</span>;
}

function CoinSummary({ seed }: { seed: SeedInfo }) {
  return (
    <div className="flex items-center gap-3">
      <TokenIcon ticker={seed.symbol} url={seed.imageUrl} />
      <div>
        <p className="text-base font-semibold text-fg">
          {seed.name} <span className="text-fg-muted">({seed.symbol})</span>
        </p>
        <p className="text-xs text-fg-muted">
          {seed.price !== null ? formatUsd(seed.price) : "—"} · 24h <ChangeCell value={seed.change24h} />
        </p>
      </div>
    </div>
  );
}

/**
 * A direct, standalone way to overlay two tokens' price action — the
 * general-purpose version of what Trend Finder's own peer rows now offer
 * per-peer (see TrendPeerTable.tsx). Reported directly: going through
 * Trend Finder first is a roundabout way to compare two tokens you already
 * have in mind, so this exists on its own, sharing the same
 * TradingViewCompareChart both places render.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ base?: string; compare?: string }>;
}) {
  const { base, compare } = await searchParams;

  const [baseInfo, compareInfo] = await Promise.all([
    base ? fetchSeedInfo(base) : Promise.resolve(null),
    compare ? fetchSeedInfo(compare) : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader title="Compare" subtitle="Overlay two tokens' price action to see who actually moved first." />

      {/* Always rendered, same convention as Trend Finder's own
          TrendRecentSearches — available regardless of where the visitor
          currently is, not just from the empty state. */}
      <CompareRecentSearches />
      {/* Only the truly bare route (neither side picked yet) redirects to
          the last comparison — a single in-progress pick is a real state
          to leave alone, not something to yank away. */}
      {!base && !compare && <CompareLastSearchRedirect />}
      {baseInfo && compareInfo && (
        <RecordRecentWallet
          id={`${baseInfo.id}:${compareInfo.id}`}
          name={`${baseInfo.symbol} vs ${compareInfo.symbol}`}
          namespace="compareSearches"
          maxRecent={5}
        />
      )}

      <Panel className="mb-6">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium text-fg-muted">Token A</p>
            <CompareCoinPicker paramKey="base" placeholder="Search a ticker or coin name (e.g. NEAR)…" />
            {base && !baseInfo && (
              <p className="mt-3 text-sm text-negative">CoinGecko has no market data for &ldquo;{base}&rdquo;.</p>
            )}
            {baseInfo && (
              <div className="mt-3">
                <CoinSummary seed={baseInfo} />
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-fg-muted">Token B</p>
            <CompareCoinPicker paramKey="compare" placeholder="Search a ticker or coin name (e.g. AAVE)…" />
            {compare && !compareInfo && (
              <p className="mt-3 text-sm text-negative">CoinGecko has no market data for &ldquo;{compare}&rdquo;.</p>
            )}
            {compareInfo && (
              <div className="mt-3">
                <CoinSummary seed={compareInfo} />
              </div>
            )}
          </div>
        </div>
      </Panel>

      {baseInfo && compareInfo ? (
        <Panel title={`${baseInfo.symbol} vs ${compareInfo.symbol}`}>
          <TradingViewCompareChart baseTicker={baseInfo.symbol} compareTicker={compareInfo.symbol} />
        </Panel>
      ) : (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">Pick two tokens above to see them overlaid.</p>
        </Panel>
      )}
    </>
  );
}

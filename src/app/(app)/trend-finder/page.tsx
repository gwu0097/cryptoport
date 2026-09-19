import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TokenIcon } from "@/components/TokenIcon";
import { TrendSeedPicker } from "@/components/TrendSeedPicker";
import { formatUsd, formatCompactUsd, formatPercent } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { findTrendPeers, type TrendTier } from "@/lib/trendPeers";

export const dynamic = "force-dynamic";
// A cold cache can chain ~5 sequential CoinGecko calls with backoff (see
// trendPeers.ts/coingecko.ts's CATEGORY_FETCH_OPTS) — same order of
// magnitude as lookup/page.tsx's own maxDuration for the same reason.
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
  searchParams: Promise<{ id?: string; mcap?: string }>;
}) {
  const { id, mcap } = await searchParams;
  const mcapFloor = mcap !== undefined && !Number.isNaN(Number(mcap)) ? Number(mcap) : DEFAULT_MCAP_FLOOR;

  return (
    <>
      <PageHeader
        title="Trend finder"
        subtitle="Pick a token that already moved — see sector peers that haven't yet."
      />

      {!id ? (
        <Panel className="text-center">
          <p className="mb-4 text-sm text-fg-muted">
            Search for a token to find peers in the same sector that haven&rsquo;t moved as much yet.
          </p>
          <div className="mx-auto max-w-sm text-left">
            <TrendSeedPicker />
          </div>
        </Panel>
      ) : (
        <TrendResults id={id} mcapFloor={mcapFloor} />
      )}
    </>
  );
}

async function TrendResults({ id, mcapFloor }: { id: string; mcapFloor: number }) {
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
      <Panel className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <TokenIcon ticker={seed.symbol} url={seed.imageUrl} />
            <div>
              <p className="text-lg font-semibold text-fg">
                {seed.name} <span className="text-fg-muted">({seed.symbol})</span>
              </p>
              <p className="text-xs text-fg-muted">
                {seed.marketCapRank !== null ? `Rank #${seed.marketCapRank}` : "Unranked"} ·{" "}
                {seed.price !== null ? formatUsd(seed.price) : "—"} · 24h <ChangeCell value={seed.change24h} />
              </p>
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

      {result.status === "no-categories" ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">
            No usable sector category found for {seed.symbol} — CoinGecko&rsquo;s categories for this token are all
            either unranked or too broad to use for peer matching.
          </p>
        </Panel>
      ) : (
        <>
          {result.tiers.map((tier, i) => (
            <TierPanel key={tier.category.id} tier={tier} index={i} mcapFloor={mcapFloor} />
          ))}
          <p className="mt-2 text-xs text-fg-muted">
            Peers come from {seed.symbol}&rsquo;s narrowest sector categories on CoinGecko — a cross-sector sympathy
            move (a token in a different sector that tends to move alongside {seed.symbol} without sharing a
            category) isn&rsquo;t detected here. Market data is live as of this page load.
          </p>
        </>
      )}
    </>
  );
}

function TierPanel({ tier, index, mcapFloor }: { tier: TrendTier; index: number; mcapFloor: number }) {
  const { category, peers } = tier;
  return (
    <Panel
      className="mb-4"
      title={`Tier ${index + 1} · ${category.name}`}
      description={
        <>
          {formatCompactUsd(category.marketCap)} category market cap · 24h{" "}
          <ChangeCell value={category.marketCapChange24h} />
        </>
      }
    >
      {peers.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No peers above {mcapFloor > 0 ? formatCompactUsd(mcapFloor) : "$0"} in this tier — try a lower market cap
          floor above.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr className={theadRowClass}>
                <th className={thClass}>Asset</th>
                <th className={thClass}>Price</th>
                <th className={`${thClass} ${hideOnMobileClass}`}>1h</th>
                <th className={thClass}>24h</th>
                <th className={`${thClass} ${hideOnMobileClass}`}>7d</th>
                <th className={`${thClass} ${hideOnMobileClass}`}>Market cap</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer) => (
                <tr key={peer.id} className={trClass}>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <TokenIcon ticker={peer.symbol} url={peer.imageUrl} />
                      <span className="font-medium text-fg">{peer.symbol}</span>
                    </div>
                  </td>
                  <td className={`${tdClass} tabular-nums`}>{peer.price !== null ? formatUsd(peer.price) : "—"}</td>
                  <td className={`${tdClass} ${hideOnMobileClass}`}>
                    <ChangeCell value={peer.change1h} />
                  </td>
                  <td className={tdClass}>
                    <ChangeCell value={peer.change24h} />
                  </td>
                  <td className={`${tdClass} ${hideOnMobileClass}`}>
                    <ChangeCell value={peer.change7d} />
                  </td>
                  <td className={`${tdClass} ${hideOnMobileClass} tabular-nums text-fg-muted`}>
                    {formatCompactUsd(peer.marketCap)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

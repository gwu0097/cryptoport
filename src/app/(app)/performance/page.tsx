import { RefreshCw } from "lucide-react";
import { scopePricesToUser } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { getActiveWalletsWithHoldings, getValueHistory, getPriceMap, getWalletValueHistories, type WalletWithHoldings } from "@/lib/queries";
import { getPriceHistoryMap } from "@/lib/priceHistory";
import { estimateSeries, estimateCoverage, stitchSeries, type PriceHistoryMap, type StitchedPoint } from "@/lib/performance";
import { packSeries } from "@/lib/seriesPacking";
import { valueHolding, type PriceMap } from "@/lib/valuation";
import type { Holding } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { PerformanceChart, type WalletSeriesOption } from "@/components/performance/PerformanceChart";
import { backfillHistoryAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Performance · CryptoPort" };

// backfillHistoryAction returns almost immediately (see actions.ts), but
// its after() callback — the actual CoinGecko fetching — still runs
// against this same route's maxDuration budget.
export const maxDuration = 300;

function currentUsd(holding: Holding, prices: PriceMap): number {
  const v = valueHolding(holding, prices);
  return v.kind === "priced" ? v.usd : 0;
}

function buildOption(
  id: string,
  name: string,
  address: string | null,
  holdings: Holding[],
  prices: PriceMap,
  priceHistory: PriceHistoryMap,
  fetched: ReadonlySet<string>,
  dates: string[],
  real: { date: string; total: number }[],
): Omit<WalletSeriesOption, "packed"> & { points: StitchedPoint[] } {
  const estimated = estimateSeries(holdings, priceHistory, dates);
  const points = stitchSeries(estimated, real);
  // The estimate draws only days before the first real snapshot (today,
  // if there is none yet).
  const before = real.reduce((min, p) => (p.date < min ? p.date : min), new Date().toISOString().slice(0, 10));
  const coverage = estimateCoverage(
    holdings.map((h) => ({ ...h, currentUsd: currentUsd(h, prices) })),
    priceHistory,
    { before, fetched },
  );
  return {
    id,
    name,
    address,
    points,
    coveragePct: coverage.pct,
    unresolvedUsd: coverage.unresolvedUsd,
    unresolvedCount: coverage.unresolvedTickers.length,
    uncachedUsd: coverage.uncachedUsd,
    uncachedCount: coverage.uncachedTickers.length,
  };
}

export default async function PerformancePage({
  searchParams,
}: {
  // Set by the sidebar's "Recent" Performance-wallet links (see
  // navItems.tsx/RecentWalletsNav.tsx) — Performance has no per-wallet
  // route the way /wallets/[id] does (the wallet selection lives in
  // PerformanceChart's own client state), so a deep link back to a
  // specific wallet's chart has to go through a query param instead.
  searchParams: Promise<{ wallet?: string }>;
}) {
  scopePricesToUser(); // prices for the user's own coins only (docs/perf/PRICES_READ.md)
  const { wallet: initialWalletId } = await searchParams;
  const user = await getUser();
  // PerformanceChart is a client component built around real wallet data
  // (coverage %, range presets over actual points) — not something that
  // has a sensible "zero wallets" rendering, unlike the other tabs' plain
  // tables. A placeholder panel here rather than trying to feed it empty
  // options.
  if (!user) {
    return (
      <>
        <PageHeader title="Performance" subtitle="How your holdings have performed over time" />
        <GuestBanner message="Sign up or connect a wallet to see your own performance chart here." />
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">
            Log in and add a wallet to see how your holdings have performed over time.
          </p>
        </Panel>
      </>
    );
  }

  // Two round trips: these together, then the price history of what's held.
  const [wallets, prices, globalReal, walletHistories]: [WalletWithHoldings[], PriceMap, { date: string; total: number }[], Map<string, { date: string; total: number }[]>] =
    await Promise.all([getActiveWalletsWithHoldings(), getPriceMap(), getValueHistory(), getWalletValueHistories()]);

  const perWalletReal = wallets.map((w) => walletHistories.get(w.id) ?? []);

  const allHoldings = wallets.flatMap((w) => w.holdings);
  const { history: priceHistory, fetched } = await getPriceHistoryMap(allHoldings);

  // The estimate's date axis is exactly the days that have a stored price
  // (backfilled history or daily closes) — never a guessed/generated range
  // — so a missing day shows up as missing, not silently filled in.
  const dates = [...new Set([...priceHistory.values()].flatMap((byDate) => [...byDate.keys()]))].sort();

  const built = [
    buildOption("all", "All wallets", null, allHoldings, prices, priceHistory, fetched, dates, globalReal),
    ...wallets.map((w, i) =>
      buildOption(w.id, w.name, w.address, w.holdings, prices, priceHistory, fetched, dates, perWalletReal[i]),
    ),
  ];
  // Sent packed: the dates once, each wallet's totals as a list (seriesPacking.ts).
  const packing = packSeries(built.map((o) => o.points));
  const options: WalletSeriesOption[] = built.map((o, i) => ({
    id: o.id,
    name: o.name,
    address: o.address,
    coveragePct: o.coveragePct,
    unresolvedUsd: o.unresolvedUsd,
    unresolvedCount: o.unresolvedCount,
    uncachedUsd: o.uncachedUsd,
    uncachedCount: o.uncachedCount,
    packed: packing.packed[i],
  }));

  return (
    <>
      <PageHeader
        title="Performance"
        subtitle="How your holdings have performed over time"
        actions={
          <div className="flex flex-col items-end gap-1">
            <form action={backfillHistoryAction}>
              <SubmitButton variant="secondary" size="sm" pendingLabel="Starting…">
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Backfill history
              </SubmitButton>
            </form>
            <p className="max-w-48 text-right text-xs text-fg-muted">
              Runs in the background — refresh in a bit to see it applied.
            </p>
          </div>
        }
      />

      <PerformanceChart
        options={options}
        dates={packing.dates}
        initialWalletId={initialWalletId}
        emptyStateAction={
          <form action={backfillHistoryAction}>
            <SubmitButton variant="primary" size="sm" pendingLabel="Starting…">
              Backfill history
            </SubmitButton>
          </form>
        }
        backfillNudge={
          <form action={backfillHistoryAction}>
            <SubmitButton variant="secondary" size="sm" pendingLabel="Starting…">
              Backfill history
            </SubmitButton>
          </form>
        }
      />
    </>
  );
}

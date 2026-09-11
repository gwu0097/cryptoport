import { RefreshCw } from "lucide-react";
import { getUser } from "@/lib/auth";
import { getActiveWalletsWithHoldings, getValueHistory, getPriceMap, type WalletWithHoldings } from "@/lib/queries";
import { getPriceHistoryMap } from "@/lib/priceHistory";
import { resolveCoingeckoKey } from "@/lib/priceKey";
import { estimateSeries, estimateCoverage, stitchSeries, type PriceHistoryMap } from "@/lib/analytics";
import { valueHolding, type PriceMap } from "@/lib/valuation";
import type { Holding } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { SignInPrompt } from "@/components/SignInPrompt";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { PerformanceChart, type WalletSeriesOption } from "@/components/analytics/PerformanceChart";
import { backfillHistoryAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics · CryptoPort" };

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
  dates: string[],
  real: { date: string; total: number }[],
): WalletSeriesOption {
  const estimated = estimateSeries(holdings, priceHistory, dates);
  const points = stitchSeries(estimated, real);
  const coverage = estimateCoverage(
    holdings.map((h) => ({ ...h, currentUsd: currentUsd(h, prices) })),
    priceHistory,
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

export default async function AnalyticsPage({
  searchParams,
}: {
  // Set by the sidebar's "Recent" analytics-wallet links (see
  // navItems.tsx/RecentWalletsNav.tsx) — Analytics has no per-wallet
  // route the way /wallets/[id] does (the wallet selection lives in
  // PerformanceChart's own client state), so a deep link back to a
  // specific wallet's chart has to go through a query param instead.
  searchParams: Promise<{ wallet?: string }>;
}) {
  const { wallet: initialWalletId } = await searchParams;
  const user = await getUser();
  if (!user) {
    return (
      <>
        <PageHeader title="Analytics" subtitle="How your holdings have performed over time" />
        <SignInPrompt message="Sign up or connect a wallet to see your analytics." />
      </>
    );
  }

  const [wallets, prices, globalReal]: [WalletWithHoldings[], PriceMap, { date: string; total: number }[]] =
    await Promise.all([getActiveWalletsWithHoldings(), getPriceMap(), getValueHistory()]);

  const perWalletReal = await Promise.all(wallets.map((w) => getValueHistory(w.id)));

  const allHoldings = wallets.flatMap((w) => w.holdings);
  const keys = [...new Set(allHoldings.map(resolveCoingeckoKey).filter((k): k is string => k !== null))];
  const priceHistory = await getPriceHistoryMap(keys);

  // The estimate's date axis is exactly what price_history actually has
  // cached — never a guessed/generated range — so a missing day shows up
  // as missing, not silently filled in.
  const dates = [...new Set([...priceHistory.values()].flatMap((byDate) => [...byDate.keys()]))].sort();

  const options: WalletSeriesOption[] = [
    buildOption("all", "All wallets", null, allHoldings, prices, priceHistory, dates, globalReal),
    ...wallets.map((w, i) =>
      buildOption(w.id, w.name, w.address, w.holdings, prices, priceHistory, dates, perWalletReal[i]),
    ),
  ];

  return (
    <>
      <PageHeader
        title="Analytics"
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

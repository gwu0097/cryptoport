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

// backfillHistoryAction can fire dozens of concurrent CoinGecko calls the
// first time it runs for an account — same reasoning as assets/page.tsx's
// maxDuration for refreshPricesAction.
export const maxDuration = 300;

function currentUsd(holding: Holding, prices: PriceMap): number {
  const v = valueHolding(holding, prices);
  return v.kind === "priced" ? v.usd : 0;
}

function buildOption(
  id: string,
  name: string,
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
    points,
    coveragePct: coverage.pct,
    uncoveredCount: coverage.uncoveredTickers.length,
  };
}

export default async function AnalyticsPage() {
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
    buildOption("all", "All wallets", allHoldings, prices, priceHistory, dates, globalReal),
    ...wallets.map((w, i) => buildOption(w.id, w.name, w.holdings, prices, priceHistory, dates, perWalletReal[i])),
  ];

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="How your holdings have performed over time"
        actions={
          <form action={backfillHistoryAction}>
            <SubmitButton variant="secondary" size="sm">
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Backfill history
            </SubmitButton>
          </form>
        }
      />

      <PerformanceChart
        options={options}
        emptyStateAction={
          <form action={backfillHistoryAction}>
            <SubmitButton variant="primary" size="sm">
              Backfill history
            </SubmitButton>
          </form>
        }
      />
    </>
  );
}

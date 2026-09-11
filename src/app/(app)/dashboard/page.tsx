import { Eye } from "lucide-react";
import { getAssetsGroupedByTicker, getWalletsWithTotals } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { formatUsd, formatUsdSigned, formatPercent } from "@/lib/format";
import { blendedChange } from "@/lib/dashboard";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SignInPrompt } from "@/components/SignInPrompt";
import { MoverList } from "@/components/dashboard/MoverList";
import { WalletHealthPanel } from "@/components/dashboard/WalletHealthPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · CryptoPort" };

// Same dust threshold as the Assets page's "Hide low price tokens" filter —
// a $0.001 spam token's 300% swing shouldn't dominate the movers list.
const LOW_VALUE_USD = 10;

export default async function DashboardPage() {
  const [{ groups, grand }, { wallets }, user] = await Promise.all([
    getAssetsGroupedByTicker(),
    getWalletsWithTotals(),
    getUser(),
  ]);

  if (!user) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Your portfolio at a glance" />
        <SignInPrompt message="Sign up or connect a wallet to see your dashboard." />
      </>
    );
  }

  const moversEligible = groups.filter((g) => g.change24h !== null && g.total >= LOW_VALUE_USD);
  const gainers = [...moversEligible].sort((a, b) => (b.change24h ?? -Infinity) - (a.change24h ?? -Infinity)).slice(0, 5);
  const losers = [...moversEligible].sort((a, b) => (a.change24h ?? -Infinity) - (b.change24h ?? -Infinity)).slice(0, 5);

  const change = blendedChange(groups);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Your portfolio at a glance" />

      <Panel className="mb-6">
        <p className="text-sm text-fg-muted">Total value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">{formatUsd(grand.total)}</p>
        {change && (
          <p
            className={`mt-2 text-sm tabular-nums ${
              change.pct > 0 ? "text-positive" : change.pct < 0 ? "text-negative" : "text-fg-muted"
            }`}
          >
            {formatUsdSigned(change.usd)} ({formatPercent(change.pct)}) today · based on{" "}
            {change.coveragePct.toFixed(0)}% of tracked value
          </p>
        )}
        {grand.unpricedCount > 0 && (
          <p className="mt-2 text-sm text-warning">
            {grand.unpricedCount} holding{grand.unpricedCount === 1 ? "" : "s"} unpriced and excluded from
            the total
          </p>
        )}
      </Panel>

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <MoverList title="Top gainers (24h)" groups={gainers} />
        <MoverList title="Top losers (24h)" groups={losers} />
      </div>

      <div className="mb-6">
        <WalletHealthPanel wallets={wallets} />
      </div>

      <Panel className="text-center">
        <div className="flex flex-col items-center gap-2">
          <Eye className="size-8 text-fg-muted" aria-hidden="true" />
          <p className="text-sm font-medium text-fg">Watchlist</p>
          <p className="mx-auto max-w-sm text-sm text-fg-muted">
            Watch tokens you don&rsquo;t hold yet and get notified when they&rsquo;re moving. Criteria
            still to be defined.
          </p>
          <span className="rounded-full border border-border px-3 py-1 text-xs text-fg-muted">
            Coming soon
          </span>
        </div>
      </Panel>
    </>
  );
}

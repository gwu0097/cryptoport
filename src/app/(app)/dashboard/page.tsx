import { RefreshCw } from "lucide-react";
import { getAssetsGroupedByTicker, getValueHistory, getPriceRefreshState } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { formatUsdSigned, formatPercent, formatStaleness } from "@/lib/format";
import { blendedChange } from "@/lib/dashboard";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { GuestBanner } from "@/components/GuestBanner";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { MoverList } from "@/components/dashboard/MoverList";
import { ValueHistoryChart } from "@/components/dashboard/ValueHistoryChart";
import { CryptoHeatmapPanel } from "@/components/dashboard/CryptoHeatmap";
import { refreshPricesAction } from "../wallets/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · CryptoPort" };

// refreshPricesAction refreshes both the ticker-keyed Coinbase/Jupiter pass
// and every EVM holding's CoinGecko price — same reasoning as assets/
// page.tsx's maxDuration for the same action.
export const maxDuration = 300;

// Same dust threshold as the Assets page's "Hide low price tokens" filter —
// a $0.001 spam token's 300% swing shouldn't dominate the movers list.
const LOW_VALUE_USD = 10;

export default async function DashboardPage() {
  const [{ groups, grand }, history, priceState, user] = await Promise.all([
    getAssetsGroupedByTicker(),
    getValueHistory(),
    getPriceRefreshState(),
    getUser(),
  ]);

  const moversEligible = groups.filter((g) => g.change24h !== null && g.total >= LOW_VALUE_USD);
  // Gainers/losers, not just "biggest movers either direction" — in a
  // portfolio where everything's red, "Top gainers" should show nothing
  // rather than list the smallest losses.
  const gainers = moversEligible
    .filter((g) => (g.change24h as number) > 0)
    .sort((a, b) => (b.change24h as number) - (a.change24h as number))
    .slice(0, 5);
  const losers = moversEligible
    .filter((g) => (g.change24h as number) < 0)
    .sort((a, b) => (a.change24h as number) - (b.change24h as number))
    .slice(0, 5);

  const change = blendedChange(groups);

  return (
    <>
      {/* No PageHeader on the real dashboard view — the "Dashboard" title
          and subtitle were pure repetition of the nav item you just
          clicked, and the Refresh-prices action now lives in the Total
          value box below instead of a separate header row above it, so
          there was nothing left here to justify the row's own height. */}
      {/* The unpriced-holdings count is dropped from this page specifically
          (still shown on Assets/Portfolio, where "which holdings" is the
          point) — on an at-a-glance dashboard it's a footnote competing
          with the one number that actually matters here. */}
      {user ? (
        <TotalValuePanel
          total={grand.total}
          actions={
            <form action={refreshPricesAction} className="flex items-center gap-3">
              <SubmitButton variant="secondary" size="sm" pendingLabel="Refreshing prices…">
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Refresh prices
              </SubmitButton>
              <p className="text-xs text-fg-muted">Last priced: {formatStaleness(priceState.refreshedAt)}</p>
            </form>
          }
        >
          {change && (
            <p
              className={`mt-1 text-sm tabular-nums ${
                change.pct > 0 ? "text-positive" : change.pct < 0 ? "text-negative" : "text-fg-muted"
              }`}
            >
              {formatUsdSigned(change.usd)} ({formatPercent(change.pct)}) as of last refresh · based on{" "}
              {change.coveragePct.toFixed(0)}% of tracked value
            </p>
          )}
        </TotalValuePanel>
      ) : (
        <GuestBanner message="Sign up or connect a wallet to see your own portfolio here." />
      )}

      {/* Chart and heatmap side by side rather than each full-width and
          stacked — together they used to run well past one screen's worth
          of scroll before you'd reach movers/watchlist below. Default
          grid stretch (not items-start): before enough snapshot history
          exists, ValueHistoryChart's own empty state is built to be
          stretched (centered icon + message, matching SignInPrompt/
          ComingSoon's shared shape) — items-start previously kept that
          panel short instead, which left an ungrounded gap of bare page
          background below it rather than a panel that reads as
          deliberately sized. The heatmap itself isn't gated on `user` at
          all — it's public market data, not something that needs an
          account to see. */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        {user ? (
          <ValueHistoryChart points={history} />
        ) : (
          <Panel title="Value history">
            <p className="text-sm text-fg-muted">Log in and add a wallet to see your value history here.</p>
          </Panel>
        )}
        <CryptoHeatmapPanel />
      </div>

      {/* MoverList's own empty state ("Not enough 24h data yet") is wrong
          for a guest — that's for a signed-in user whose holdings just
          don't have 24h data, not "you have no holdings at all" — so
          guests get their own placeholder panels here instead of an empty
          MoverList. */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        {user ? (
          <>
            <MoverList title="Top gainers (24h)" groups={gainers} />
            <MoverList title="Top losers (24h)" groups={losers} />
          </>
        ) : (
          <>
            <Panel title="Top gainers (24h)">
              <p className="text-sm text-fg-muted">Log in and add a wallet to see your top movers here.</p>
            </Panel>
            <Panel title="Top losers (24h)">
              <p className="text-sm text-fg-muted">Log in and add a wallet to see your top movers here.</p>
            </Panel>
          </>
        )}
      </div>

      <Panel padding={false} className="flex items-center justify-between gap-3 px-5 py-3">
        <p className="text-sm text-fg-muted">
          <span className="font-medium text-fg">Watchlist</span> — track tokens you don&rsquo;t hold yet.
        </p>
        <span className="shrink-0 rounded-full border border-border px-3 py-1 text-xs text-fg-muted">
          Coming soon
        </span>
      </Panel>
    </>
  );
}

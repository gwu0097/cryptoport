import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getAssetsGroupedByTicker, getAllWatchlistItems, getValueHistory, getPriceRefreshState } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PriceRefreshButton } from "@/components/PriceRefreshButton";
import { blendedChange } from "@/lib/dashboard";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { BlendedChangeCaption } from "@/components/BlendedChangeCaption";
import { GuestBanner } from "@/components/GuestBanner";
import { MoverList, type MoverItem } from "@/components/dashboard/MoverList";
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

// Split out of the ticker-grouped/watchlist row shapes below — same
// gainers/losers logic (not just "biggest movers either direction": in a
// portfolio (or watchlist) where everything's red, "Top gainers" should
// show nothing rather than list the smallest losses), applied to both
// Holdings and Watchlist rows via the shared MoverItem shape rather than
// two copies of this filter/sort/slice.
function topMovers(items: MoverItem[]): { gainers: MoverItem[]; losers: MoverItem[] } {
  const eligible = items.filter((i) => i.change24h !== null);
  const gainers = eligible
    .filter((i) => (i.change24h as number) > 0)
    .sort((a, b) => (b.change24h as number) - (a.change24h as number))
    .slice(0, 5);
  const losers = eligible
    .filter((i) => (i.change24h as number) < 0)
    .sort((a, b) => (a.change24h as number) - (b.change24h as number))
    .slice(0, 5);
  return { gainers, losers };
}

export default async function DashboardPage() {
  const [{ groups, grand }, watchlistItems, history, priceState, user] = await Promise.all([
    getAssetsGroupedByTicker(),
    getAllWatchlistItems(),
    getValueHistory(),
    getPriceRefreshState(),
    getUser(),
  ]);

  // Dust filter only makes sense for Holdings (a $0.001 spam token's 300%
  // swing shouldn't dominate the movers list) — a Watchlist coin has no
  // position size to filter on, every watched coin counts equally.
  const holdingsMoversEligible = groups.filter((g) => g.total >= LOW_VALUE_USD);
  const { gainers: holdingsGainers, losers: holdingsLosers } = topMovers(
    holdingsMoversEligible.map((g) => ({ key: g.tickerKey, ticker: g.ticker, iconUrl: g.iconUrl, price: g.price, change24h: g.change24h })),
  );
  const { gainers: watchlistGainers, losers: watchlistLosers } = topMovers(
    watchlistItems.map((w) => ({ key: w.coingeckoId, ticker: w.ticker, iconUrl: w.imageUrl, price: w.price, change24h: w.change24h })),
  );

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
          actions={<PriceRefreshButton priceState={priceState} refresh={refreshPricesAction} />}
        >
          {change && <BlendedChangeCaption change={change} />}
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
          MoverList. Two separate rows (Holdings, then Watchlist) rather
          than a single 4-up grid — each row is its own coherent "top
          movers among X" comparison, and the explicit "· Holdings" /
          "· Watchlist" suffix on every title (reported directly as
          ambiguous once Watchlist movers existed alongside these) makes
          which is which unambiguous without having to infer it from
          layout position alone. */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        {user ? (
          <>
            <MoverList title="Top gainers (24h) · Holdings" items={holdingsGainers} href="/assets?sort=change24h&dir=desc" />
            <MoverList title="Top losers (24h) · Holdings" items={holdingsLosers} href="/assets?sort=change24h&dir=asc" />
          </>
        ) : (
          <>
            <Panel title="Top gainers (24h) · Holdings">
              <p className="text-sm text-fg-muted">Log in and add a wallet to see your top movers here.</p>
            </Panel>
            <Panel title="Top losers (24h) · Holdings">
              <p className="text-sm text-fg-muted">Log in and add a wallet to see your top movers here.</p>
            </Panel>
          </>
        )}
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        {user ? (
          <>
            <MoverList title="Top gainers (24h) · Watchlist" items={watchlistGainers} href="/watchlist?sort=change24h&dir=desc" />
            <MoverList title="Top losers (24h) · Watchlist" items={watchlistLosers} href="/watchlist?sort=change24h&dir=asc" />
          </>
        ) : (
          <>
            <Panel title="Top gainers (24h) · Watchlist">
              <p className="text-sm text-fg-muted">Log in and create a watchlist to see your top movers here.</p>
            </Panel>
            <Panel title="Top losers (24h) · Watchlist">
              <p className="text-sm text-fg-muted">Log in and create a watchlist to see your top movers here.</p>
            </Panel>
          </>
        )}
      </div>

      <Link
        href="/watchlist"
        className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-5 py-3 text-sm transition hover:bg-surface-raised"
      >
        <span className="text-fg-muted">
          <span className="font-medium text-fg">Watchlist</span> — track tokens you don&rsquo;t hold yet.
        </span>
        <ChevronRight className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
      </Link>
    </>
  );
}

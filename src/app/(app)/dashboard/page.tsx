import {
  scopePricesToUser,
  getAssetsGroupedByTicker,
  getAllWatchlistItems,
  getWatchlists,
  getWatchlistItems,
  getValueHistory,
  getPriceRefreshState,
  getOpenPositions,
} from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PriceRefreshButton } from "@/components/PriceRefreshButton";
import { blendedChange, withLiveToday } from "@/lib/dashboard";
import { requestNowSec } from "@/lib/requestClock";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import type { MoverItem } from "@/components/dashboard/MoverList";
import { MoversCard } from "@/components/dashboard/MoversCard";
import { DashboardStats } from "@/components/dashboard/DashboardStats";
import { summarizePositions } from "@/lib/positionsSummary";
import { ValueHistoryChart } from "@/components/dashboard/ValueHistoryChart";
import { CryptoHeatmapPanel } from "@/components/dashboard/CryptoHeatmap";
import { DashboardWatchlistFilter } from "@/components/dashboard/DashboardWatchlistFilter";
import { DashboardWatchlistRedirect } from "@/components/dashboard/DashboardWatchlistRedirect";
import { OpenPositionsPanel } from "@/components/dashboard/OpenPositionsPanel";
import { getEffectiveTimeZone } from "@/lib/preferences";
import { formatDateTime } from "@/lib/format";
import { getWatchDayActivity, getWatchFeedTargets, getWatchMovements } from "@/lib/watchQuery";
import { DashboardWatchActivity } from "@/components/dashboard/DashboardWatchActivity";
import { DashboardTrackedTrades } from "@/components/dashboard/DashboardTrackedTrades";
import { readTrackedTrades } from "@/lib/perpScoutScan";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · CryptoPort" };

// Refresh prices (api/prices/refresh) runs one pricing pass (refreshAssetPrices, four
// source lanes) in after() — same reasoning as assets/page.tsx's
// maxDuration for the same action.
export const maxDuration = 300;

// Same dust threshold as the Assets page's "Hide low price tokens" filter —
// a $0.001 spam token's 300% swing shouldn't dominate the movers list.
const LOW_VALUE_USD = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    .slice(0, 8);
  const losers = eligible
    .filter((i) => (i.change24h as number) < 0)
    .sort((a, b) => (a.change24h as number) - (b.change24h as number))
    .slice(0, 8);
  return { gainers, losers };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string }>;
}) {
  scopePricesToUser(true); // the user's own coins and the Wallet Watch coins they see (docs/perf/PRICES_READ.md)
  const { list } = await searchParams;
  // getUser is local (the token's signature, auth.ts), so knowing it first
  // costs no round trip — and every read below starts at once: nothing here
  // waits on another read (CLAUDE.md §6 round-trip budget).
  const user = await getUser();
  const [{ groups, grand }, watchlists, history, priceState, positions, zone, listedItems, watch, trackedTrades] = await Promise.all([
    getAssetsGroupedByTicker(),
    getWatchlists(),
    getValueHistory(),
    getPriceRefreshState(),
    getOpenPositions(),
    getEffectiveTimeZone(),
    // Only a well-formed id is read (a malformed one would be a query error).
    list && UUID.test(list) ? getWatchlistItems(list) : getAllWatchlistItems(),
    user ? loadWatchActivity() : null,
    // Perp Scout's tracked trades (one app_settings read; a failure only
    // hides the card).
    user ? readTrackedTrades(user.id).catch(() => null) : null,
  ]);
  // The newest moment any position's PnL is from (a price refresh's mark, or
  // a wallet sync) — shown once for the section.
  const positionsAsOf = positions.map((p) => p.pnlAsOf).filter((t): t is string => !!t).sort().at(-1) ?? null;

  // A real, currently-existing watchlist id (never trusts `list` blindly —
  // a stale localStorage value for a since-deleted watchlist should fall
  // back to "All", not 404 or silently show nothing) — undefined means
  // "All watchlists," getAllWatchlistItems()'s existing cross-list summary.
  const selectedWatchlist = list ? watchlists.find((w) => w.id === list) : undefined;
  // The list's items were read before knowing it exists: a stale id (only)
  // costs one more read, of all watchlists.
  const watchlistItems = list && UUID.test(list) && !selectedWatchlist ? await getAllWatchlistItems() : listedItems;

  // Dust filter only makes sense for Holdings (a $0.001 spam token's 300%
  // swing shouldn't dominate the movers list) — a Watchlist coin has no
  // position size to filter on, every watched coin counts equally.
  const holdingsMoversEligible = groups.filter((g) => g.total >= LOW_VALUE_USD);
  // Full (undust-filtered) ticker -> position value, so a Watchlist row's
  // "you own this" figure reflects any real holding, not just ones above
  // the Holdings movers' own dust cutoff — direct ask: "also do it for
  // the watchlist tokens if i own them," not "if I own a dust-filtered
  // amount of them."
  // Keyed by CoinGecko coin id, never ticker (docs/pricing/PLAN.md): asset
  // rows are one per coin, and two rows can share a ticker — MORPHO's coin
  // row (~$10K) and a Merkl rewards position ($4.54) did, and a ticker map
  // kept the $4.54 (2026-09-25). Summed, in case one coin spans rows.
  const coinValueMap = new Map<string, number>();
  for (const g of groups) if (g.coingeckoId) coinValueMap.set(g.coingeckoId, (coinValueMap.get(g.coingeckoId) ?? 0) + g.total);
  const { gainers: holdingsGainers, losers: holdingsLosers } = topMovers(
    holdingsMoversEligible.map((g) => ({
      key: g.tickerKey,
      ticker: g.ticker,
      iconUrl: g.iconUrl,
      price: g.price,
      change24h: g.change24h,
      // Now resolved server-side (see AssetGroup.coingeckoId) instead of
      // always falling back to MoverList's own best-effort ?ticker=
      // resolution — undefined (not null) when unresolved, matching
      // MoverItem's own optional-field convention.
      coingeckoId: g.coingeckoId ?? undefined,
      holdingValueUsd: g.total,
    })),
  );
  const { gainers: watchlistGainers, losers: watchlistLosers } = topMovers(
    watchlistItems.map((w) => ({
      key: w.coingeckoId,
      ticker: w.ticker,
      iconUrl: w.imageUrl,
      price: w.price,
      change24h: w.change24h,
      // Watchlist rows already carry a real CoinGecko id — unlike Holdings
      // rows below, so their "Find Trend" link can go straight to the
      // unambiguous ?id= path (see MoverItem's own doc comment).
      coingeckoId: w.coingeckoId,
      // undefined (not 0) when the user doesn't actually hold this ticker
      // — the normal case for most watchlist entries, matching
      // MoverItem.holdingValueUsd's own "undefined means not held" rule.
      holdingValueUsd: coinValueMap.get(w.coingeckoId),
    })),
  );

  const change = blendedChange(groups);

  // Forwards the same selected list to the real Watchlist page (?list=)
  // when one's chosen, so clicking through from a per-list Dashboard panel
  // lands on that exact list rather than whichever one that page falls
  // back to on its own (see WatchlistPage's own doc comment on that
  // fallback, written before Dashboard had a per-list selector to forward
  // here).
  const watchlistHrefBase = selectedWatchlist ? `/watchlist?list=${selectedWatchlist.id}&` : "/watchlist?";

  const summary = positions.length > 0 ? summarizePositions(positions) : null;
  const watchStats =
    watch && watch.hasInfluencers ? { coins: watch.day.coins.length, traders: new Set(watch.day.coins.map((c) => c.influencerId)).size } : null;
  const guestNote = (noun: string) => <p className="text-sm text-fg-muted">Log in and add a wallet to see your {noun} here.</p>;

  // A 12-column grid (industry convention: headline numbers on top, main
  // content left, secondary right; Fable's reviews 2026-09-29). Width: the
  // Dashboard is full-width (data-page-width, AppShell). Row 1: chart and
  // movers. Wallet Watch gets a full row (its table wraps in less), and the
  // heatmap one below it — except from 1920px (3xl), where the heatmap sits
  // beside Wallet Watch (8 | 4; full width when there's no Wallet Watch)
  // and open positions go last. Cards fill their row's height.
  // Phone order (order-*): numbers, chart, Wallet Watch, movers, positions,
  // heatmap; from xl the document order places them (dense fills gaps).
  return (
    <div data-page-width="full" className="grid grid-flow-row-dense grid-cols-1 gap-4 xl:grid-cols-12">
      <div className="order-1 xl:order-none xl:col-span-12">
        {user ? (
          <DashboardStats total={grand.total} change={change} positions={summary} watch={watchStats} refresh={<PriceRefreshButton priceState={priceState} compact />} />
        ) : (
          <GuestBanner message="Sign up or connect a wallet to see your own portfolio here." />
        )}
      </div>

      <div className="order-2 xl:order-none xl:col-span-5 2xl:col-span-6">
        {user ? (
          <ValueHistoryChart points={withLiveToday(history, new Date(requestNowSec() * 1000).toISOString().slice(0, 10), grand.total)} />
        ) : (
          <Panel title="Value history">{guestNote("value history")}</Panel>
        )}
      </div>

      <div className="order-4 xl:order-none xl:col-span-7 2xl:col-span-6">
        {user ? (
          <MoversCard
            holdings={{ gainers: holdingsGainers, losers: holdingsLosers }}
            watchlist={{ gainers: watchlistGainers, losers: watchlistLosers }}
            watchlistFilter={watchlists.length > 0 ? <DashboardWatchlistFilter watchlists={watchlists} selected={selectedWatchlist?.id} /> : undefined}
            holdingsHref={{ gainers: "/assets?sort=change24h&dir=desc", losers: "/assets?sort=change24h&dir=asc" }}
            watchlistHref={{ gainers: `${watchlistHrefBase}sort=change24h&dir=desc`, losers: `${watchlistHrefBase}sort=change24h&dir=asc` }}
          />
        ) : (
          <Panel title="Top movers (24h)">{guestNote("top movers")}</Panel>
        )}
      </div>

      {watch && watch.hasInfluencers && (
        <div className="order-3 min-w-0 xl:order-none xl:col-span-12 3xl:col-span-8">
          <DashboardWatchActivity movements={watch.movements} groups={watch.groups} influencers={watch.influencers} day={watch.day} serverNowSec={requestNowSec()} />
        </div>
      )}

      {/* Open positions left, Perp Scout's tracked trades right (owner
          2026-10-06); either alone takes the full row. */}
      {user && positions.length > 0 && (
        <div className={`order-5 min-w-0 xl:order-none 3xl:order-last ${trackedTrades ? "xl:col-span-6" : "xl:col-span-12"}`}>
          <OpenPositionsPanel
            positions={positions}
            asOfLabel={`Updated ${positionsAsOf ? formatDateTime(positionsAsOf, zone.tz) : "—"}. Refresh positions re-reads these accounts (new and closed positions included); Refresh prices updates perp PnL from the venue's mark.`}
          />
        </div>
      )}

      {trackedTrades && (
        <div className={`order-5 min-w-0 xl:order-none 3xl:order-last ${positions.length > 0 ? "xl:col-span-6" : "xl:col-span-12"}`}>
          <DashboardTrackedTrades {...trackedTrades} serverNowSec={requestNowSec()} />
        </div>
      )}

      {/* Public market data (not the user's): for everyone, last on a phone. */}
      <div className={`order-6 xl:order-none xl:col-span-12 ${watch && watch.hasInfluencers ? "3xl:col-span-4" : ""}`}>
        <CryptoHeatmapPanel />
      </div>

      {/* Only on the bare, param-less landing state — never overrides an explicit ?list=. */}
      {user && !list && <DashboardWatchlistRedirect />}
    </div>
  );
}

/** The latest movements across everyone the user watches (the Dashboard's
 * group filter works on these in the browser, so it's instant). */
async function loadWatchActivity() {
  const { groups, influencers } = await getWatchFeedTargets();
  const [movements, day] = await Promise.all([getWatchMovements(influencers, 100), getWatchDayActivity(influencers)]);
  return {
    day,
    hasInfluencers: influencers.length > 0,
    groups,
    influencers,
    movements,
  };
}

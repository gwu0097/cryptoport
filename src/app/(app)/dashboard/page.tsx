import {
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
import { blendedChange } from "@/lib/dashboard";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { BlendedChangeCaption } from "@/components/BlendedChangeCaption";
import { GuestBanner } from "@/components/GuestBanner";
import { MoverList, type MoverItem } from "@/components/dashboard/MoverList";
import { ValueHistoryChart } from "@/components/dashboard/ValueHistoryChart";
import { CryptoHeatmapPanel } from "@/components/dashboard/CryptoHeatmap";
import { DashboardWatchlistFilter } from "@/components/dashboard/DashboardWatchlistFilter";
import { DashboardWatchlistRedirect } from "@/components/dashboard/DashboardWatchlistRedirect";
import { refreshPricesAction } from "../wallets/actions";
import { OpenPositionsPanel } from "@/components/dashboard/OpenPositionsPanel";
import { getEffectiveTimeZone } from "@/lib/preferences";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · CryptoPort" };

// refreshPricesAction runs one pricing pass (refreshAssetPrices, four
// source lanes) in after() — same reasoning as assets/page.tsx's
// maxDuration for the same action.
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string }>;
}) {
  const { list } = await searchParams;
  const [{ groups, grand }, watchlists, history, priceState, user, positions, zone] = await Promise.all([
    getAssetsGroupedByTicker(),
    getWatchlists(),
    getValueHistory(),
    getPriceRefreshState(),
    getUser(),
    getOpenPositions(),
    getEffectiveTimeZone(),
  ]);
  // The newest moment any position's PnL is from (a price refresh's mark, or
  // a wallet sync) — shown once for the section.
  const positionsAsOf = positions.map((p) => p.pnlAsOf).filter((t): t is string => !!t).sort().at(-1) ?? null;

  // A real, currently-existing watchlist id (never trusts `list` blindly —
  // a stale localStorage value for a since-deleted watchlist should fall
  // back to "All", not 404 or silently show nothing) — undefined means
  // "All watchlists," getAllWatchlistItems()'s existing cross-list summary.
  const selectedWatchlist = list ? watchlists.find((w) => w.id === list) : undefined;
  const watchlistItems = selectedWatchlist
    ? await getWatchlistItems(selectedWatchlist.id)
    : await getAllWatchlistItems();

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

      {user && positions.length > 0 && (
        <OpenPositionsPanel
          positions={positions}
          asOfLabel={`PnL as of ${positionsAsOf ? formatDateTime(positionsAsOf, zone.tz) : "—"} — Refresh prices updates it from the venue's mark price; a position opened or closed since shows up on the wallet's next sync.`}
        />
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

      {/* Only mounted on the bare, param-less landing state (same
          convention as TrendLastSearchRedirect) — never overrides an
          explicit ?list= already in the URL. */}
      {user && !list && <DashboardWatchlistRedirect />}

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        {user ? (
          <>
            {/* The dropdown itself names the selected list (or "All
                watchlists") inline in this panel's own title — no separate
                row, and the Top losers panel below doesn't repeat the name
                a second time, per the direct ask ("no need to say it
                twice, save space"). */}
            <MoverList
              title="Top gainers (24h)"
              items={watchlistGainers}
              href={`${watchlistHrefBase}sort=change24h&dir=desc`}
              filter={
                watchlists.length > 0 ? (
                  <DashboardWatchlistFilter watchlists={watchlists} selected={selectedWatchlist?.id} />
                ) : undefined
              }
            />
            <MoverList
              title="Top losers (24h) · Watchlist"
              items={watchlistLosers}
              href={`${watchlistHrefBase}sort=change24h&dir=asc`}
            />
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
    </>
  );
}

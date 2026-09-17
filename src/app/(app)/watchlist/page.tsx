import { getWatchlists, getWatchlistItems, getPriceRefreshState } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PriceRefreshButton } from "@/components/PriceRefreshButton";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { WatchlistTabs } from "@/components/watchlist/WatchlistTabs";
import { WatchlistTable, SORT_KEYS, type Sort } from "@/components/watchlist/WatchlistTable";
import { AddCoinPanel } from "@/components/watchlist/AddCoinPanel";
import { createWatchlist } from "./actions";
import { refreshPricesAction } from "../wallets/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/Field";

export const dynamic = "force-dynamic";
export const metadata = { title: "Watchlist · CryptoPort" };

// Same reasoning as assets/page.tsx's own maxDuration — this page's
// "Refresh prices" button now also refreshes every watched coin's market
// data (see wallets/actions.ts's runPriceRefresh), on top of holdings.
export const maxDuration = 300;

// See assets/page.tsx's own parseInitialSort for the full reasoning — same
// Dashboard "view all" link feature, validated against this table's own
// SORT_KEYS rather than trusted.
function parseInitialSort(sort?: string, dir?: string): Sort | undefined {
  if (!sort || !SORT_KEYS.includes(sort as (typeof SORT_KEYS)[number])) return undefined;
  return { key: sort as (typeof SORT_KEYS)[number], dir: dir === "asc" ? "asc" : "desc" };
}

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string; sort?: string; dir?: string }>;
}) {
  const { list: listParam, sort, dir } = await searchParams;
  const initialSort = parseInitialSort(sort, dir);
  const [watchlists, user, priceState] = await Promise.all([
    getWatchlists(),
    getUser(),
    getPriceRefreshState(),
  ]);

  // A Dashboard "view all" link (see MoverList) has no particular list in
  // mind — Dashboard's own Watchlist movers panel is summarized across
  // every list (getAllWatchlistItems), which this page has no single-list
  // equivalent of — so it just lands on whichever list is selected/first,
  // sorted the way the click asked for. Good enough for the common case
  // (one main watchlist); a true cross-list "full list" view is a bigger
  // feature this wasn't asked to build.
  const selected = watchlists.find((w) => w.id === listParam) ?? watchlists[0];
  const items = selected ? await getWatchlistItems(selected.id) : [];

  return (
    <>
      <PageHeader
        title="Watchlist"
        subtitle="Track tokens you don't hold yet"
        actions={user && <PriceRefreshButton priceState={priceState} refresh={refreshPricesAction} />}
      />

      {!user && <GuestBanner message="Sign up to create a watchlist and track tokens here." />}

      {!user ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">Log in to create a watchlist here.</p>
        </Panel>
      ) : watchlists.length === 0 || !selected ? (
        <Panel title="Create your first watchlist" description="Track any coin's price without having to hold it.">
          <form action={createWatchlist} className="flex flex-wrap items-center gap-2">
            <input
              name="name"
              type="text"
              required
              placeholder="e.g. Meme coins, DeFi blue chips…"
              className={`${inputClass} max-w-xs`}
            />
            <SubmitButton pendingLabel="Creating…">Create watchlist</SubmitButton>
          </form>
        </Panel>
      ) : (
        <>
          <WatchlistTabs watchlists={watchlists} selected={selected} />
          <div className="mb-4">
            <AddCoinPanel watchlistId={selected.id} />
          </div>
          {items.length === 0 ? (
            <Panel className="text-center">
              <p className="text-sm text-fg-muted">
                Nothing tracked in &ldquo;{selected.name}&rdquo; yet — search or paste tickers above to add some.
              </p>
            </Panel>
          ) : (
            <WatchlistTable items={items} initialSort={initialSort} />
          )}
        </>
      )}
    </>
  );
}

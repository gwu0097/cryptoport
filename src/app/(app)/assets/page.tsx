import { getAssetsGroupedByTicker, getChainIconMap, getPriceRefreshState } from "@/lib/queries";
import { chainAllocations } from "@/lib/chainAllocation";
import { ChainAllocationPanel } from "@/components/ChainAllocationPanel";
import { getUser } from "@/lib/auth";
import { PriceRefreshButton } from "@/components/PriceRefreshButton";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { CheckboxLink } from "@/components/ui/CheckboxLink";
import { AssetsTable, type Sort } from "@/components/AssetsTable";
import { CoinAllocationChart } from "@/components/CoinAllocationChart";
import { GuestBanner } from "@/components/GuestBanner";
import { ASSET_SORT_KEYS } from "@/lib/sortKeys";
import { refreshPricesAction } from "../wallets/actions";

// A Dashboard movers panel ("Top gainers (24h) · Holdings", see
// MoverList) links here with `?sort=change24h&dir=desc` (or `dir=asc` for
// losers) so clicking through the 5-row preview lands on the full list
// sorted the same way, instead of resetting to whatever was last sorted
// (see AssetsTable's own doc comment for how this wins over the persisted
// sort). Validated against ASSET_SORT_KEYS rather than trusted — a stray/
// typo'd query string should just fall back to no override, not crash the
// page. Imported from lib/sortKeys.ts, NOT from AssetsTable.tsx — that
// file is "use client"; a Server Component importing a runtime constant
// (not JSX) from a client-boundary module gets an opaque client-reference
// stub instead of the real array, which is exactly what broke this page
// live the first time (`.includes` on a stub isn't a real array method —
// crashed with a server error on every request).
function parseInitialSort(sort?: string, dir?: string): Sort | undefined {
  if (!sort || !ASSET_SORT_KEYS.includes(sort as (typeof ASSET_SORT_KEYS)[number])) return undefined;
  return { key: sort as (typeof ASSET_SORT_KEYS)[number], dir: dir === "asc" ? "asc" : "desc" };
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets · CryptoPort" };

// refreshPricesAction now also re-prices every EVM holding directly from
// CoinGecko (see refreshEvmHoldingPrices) on top of the Coinbase/Jupiter
// ticker pass — same reasoning as wallets/page.tsx's maxDuration for the
// same action.
export const maxDuration = 300;

const LOW_VALUE_USD = 10;

function buildHref(hideUnpriced: boolean, hideLow: boolean): string {
  const params = new URLSearchParams();
  // Both default to checked/true — only recorded in the URL when turned
  // off, so a bare link (e.g. the sidebar) lands on the clean default view.
  if (!hideUnpriced) params.set("hideUnpriced", "0");
  if (!hideLow) params.set("hideLow", "0");
  const qs = params.toString();
  return qs ? `/assets?${qs}` : "/assets";
}

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ hideUnpriced?: string; hideLow?: string; sort?: string; dir?: string }>;
}) {
  const { hideUnpriced: hideUnpricedParam, hideLow: hideLowParam, sort, dir } = await searchParams;
  const hideUnpriced = hideUnpricedParam !== "0";
  const hideLow = hideLowParam !== "0";
  const initialSort = parseInitialSort(sort, dir);

  const [{ groups, grand }, user, priceState, chainIcons] = await Promise.all([
    getAssetsGroupedByTicker(),
    getUser(),
    getPriceRefreshState(),
    getChainIconMap(),
  ]);
  // Value by chain split by asset type, from the same holdings (and so the
  // same total) as the Coin allocation chart — see chainAllocation.ts.
  const chains = chainAllocations(groups.flatMap((g) => g.holdings));

  // Same semantics as ChainGroupedHoldings: filter which contributing
  // holdings show in a group's breakdown table, but the group's own
  // total/unpricedCount stay as originally computed (not recomputed from
  // the filtered subset) — an asset that's entirely unpriced/low-value
  // drops out of the list entirely once nothing's left to show.
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      holdings: group.holdings.filter((h) => {
        if (h.valuation.kind === "unpriced") return !hideUnpriced;
        if (hideLow && h.valuation.usd < LOW_VALUE_USD) return false;
        return true;
      }),
    }))
    .filter((group) => group.holdings.length > 0);

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle="Every token you hold, aggregated across all your wallets"
        actions={user && <PriceRefreshButton priceState={priceState} refresh={refreshPricesAction} />}
      />

      {user ? (
        <TotalValuePanel total={grand.total}>
          {grand.unpricedCount > 0 && (
            <p className="mt-2 text-sm text-warning">
              {grand.unpricedCount} holding{grand.unpricedCount === 1 ? "" : "s"} unpriced and
              excluded from the total
            </p>
          )}
        </TotalValuePanel>
      ) : (
        <GuestBanner message="Sign up or connect a wallet to see your own assets here." />
      )}

      {groups.length === 0 ? (
        user ? (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">
              No holdings yet — add or sync a wallet to see your assets here.
            </p>
          </Panel>
        ) : (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">Log in and add a wallet to see your assets here.</p>
          </Panel>
        )
      ) : (
        <>
          {user && (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <ChainAllocationPanel chains={chains} total={grand.total} icons={chainIcons} />
              <CoinAllocationChart groups={groups} total={grand.total} className="" />
            </div>
          )}

          <div className="mb-4 flex justify-end gap-4">
            <CheckboxLink
              href={buildHref(!hideUnpriced, hideLow)}
              checked={hideUnpriced}
              label="Hide unpriced"
            />
            <CheckboxLink
              href={buildHref(hideUnpriced, !hideLow)}
              checked={hideLow}
              label={`Hide low price tokens (< $${LOW_VALUE_USD})`}
            />
          </div>

          {visibleGroups.length === 0 ? (
            <Panel className="text-center">
              <p className="text-sm text-fg-muted">Nothing to show here.</p>
            </Panel>
          ) : (
            <AssetsTable groups={visibleGroups} total={grand.total} initialSort={initialSort} />
          )}
        </>
      )}
    </>
  );
}

import { getAssetsGroupedByChain, getPriceRefreshState, getWalletsWithTotals } from "@/lib/queries";
import { scopePricesToUser } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PriceRefreshButton } from "@/components/PriceRefreshButton";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { GuestBanner } from "@/components/GuestBanner";
import { SyncAllWalletsButton } from "@/components/SyncAllWalletsButton";
import { CheckboxLink } from "@/components/ui/CheckboxLink";

/** The same view with "merge same coin" flipped, other filters kept. */
function mergeToggleHref(filters: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const k of ["chain", "protocol", "hideUnpriced", "hideLow"]) if (filters[k]) q.set(k, filters[k]!);
  if (filters.merge !== "1") q.set("merge", "1");
  const s = q.toString();
  return s ? `/portfolio?${s}` : "/portfolio";
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Portfolio · CryptoPort" };

// Refresh prices (api/prices/refresh) runs one pricing pass (refreshAssetPrices, four
// source lanes) in after() — same reasoning as wallets/page.tsx's
// maxDuration for the same action.
export const maxDuration = 300;

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; protocol?: string; hideUnpriced?: string; hideLow?: string; merge?: string }>;
}) {
  scopePricesToUser(); // prices for the user's own coins only (docs/perf/PRICES_READ.md)
  const { chain: selectedChain, protocol: selectedProtocol, hideUnpriced, hideLow, merge } = await searchParams;
  const merged = merge === "1";
  const [{ groups, grand }, priceState, user, { wallets }] = await Promise.all([
    getAssetsGroupedByChain({ merge: merged }),
    getPriceRefreshState(),
    getUser(),
    getWalletsWithTotals(),
  ]);

  return (
    <>
      <PageHeader title="Portfolio" subtitle="Every holding across all your wallets, grouped by chain" />

      {user ? (
        <TotalValuePanel
          total={grand.total}
          actions={
            <div className="flex items-center gap-3">
              <SyncAllWalletsButton wallets={wallets} />
              <PriceRefreshButton priceState={priceState} />
            </div>
          }
        >
          {grand.unpricedCount > 0 && (
            <p className="mt-2 text-sm text-warning">
              {grand.unpricedCount} holding{grand.unpricedCount === 1 ? "" : "s"} unpriced and
              excluded from the total
            </p>
          )}
        </TotalValuePanel>
      ) : (
        <GuestBanner message="Sign up or connect a wallet to see your own portfolio here." />
      )}

      {/* groups is always [] for a guest (getAssetsGroupedByChain's own
          no-user guard), so this only ever needs to check `user`, not
          groups.length too. */}
      {!user ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">Log in and add a wallet to see your portfolio here.</p>
        </Panel>
      ) : (
        <ChainGroupedHoldings
          groups={groups}
          grandTotal={grand.total}
          selectedChain={selectedChain}
          selectedProtocol={selectedProtocol}
          hideUnpriced={hideUnpriced !== "0"}
          hideLow={hideLow !== "0"}
          baseHref={merged ? "/portfolio?merge=1" : "/portfolio"}
          actions={<CheckboxLink href={mergeToggleHref({ chain: selectedChain, protocol: selectedProtocol, hideUnpriced, hideLow, merge })} checked={merged} label="Merge same coin across wallets" />}
          emptyMessage="No holdings yet — add or sync a wallet to see your portfolio here."
        />
      )}
    </>
  );
}

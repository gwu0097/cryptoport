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

/** The same view with one view toggle ("merge" or "wallets") flipped, the
 * other filters kept. */
function toggleHref(filters: Record<string, string | undefined>, flip: "merge" | "wallets"): string {
  const q = new URLSearchParams();
  for (const k of ["chain", "protocol", "hideUnpriced", "hideLow", "merge", "wallets"]) if (k !== flip && filters[k]) q.set(k, filters[k]!);
  if (filters[flip] !== "1") q.set(flip, "1");
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
  searchParams: Promise<{ chain?: string; protocol?: string; hideUnpriced?: string; hideLow?: string; merge?: string; wallets?: string }>;
}) {
  scopePricesToUser(); // prices for the user's own coins only (docs/perf/PRICES_READ.md)
  const { chain: selectedChain, protocol: selectedProtocol, hideUnpriced, hideLow, merge, wallets: walletsParam } = await searchParams;
  const merged = merge === "1";
  // Which wallet each row is from: hidden by default (owner 2026-10-09:
  // "keep the page clean"), a checkbox away.
  const showWallets = walletsParam === "1";
  const filters = { chain: selectedChain, protocol: selectedProtocol, hideUnpriced, hideLow, merge, wallets: walletsParam };
  const viewQuery = new URLSearchParams({ ...(merged ? { merge: "1" } : {}), ...(showWallets ? { wallets: "1" } : {}) }).toString();
  const [{ groups, grand }, priceState, user, { wallets }] = await Promise.all([
    getAssetsGroupedByChain({ merge: merged, wallets: showWallets }),
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
          baseHref={viewQuery ? `/portfolio?${viewQuery}` : "/portfolio"}
          actions={
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <CheckboxLink href={toggleHref(filters, "merge")} checked={merged} label="Merge same coin across wallets" />
              <CheckboxLink href={toggleHref(filters, "wallets")} checked={showWallets} label="Show wallets" />
            </div>
          }
          emptyMessage="No holdings yet — add or sync a wallet to see your portfolio here."
        />
      )}
    </>
  );
}

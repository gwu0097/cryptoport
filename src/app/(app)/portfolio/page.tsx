import { RefreshCw } from "lucide-react";
import { getAssetsGroupedByChain, getPriceRefreshState } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { formatStaleness } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { GuestBanner } from "@/components/GuestBanner";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { refreshPricesAction, syncAllWallets } from "../wallets/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Portfolio · CryptoPort" };

// refreshPricesAction re-prices every EVM holding directly from CoinGecko
// on top of the Coinbase/Jupiter ticker pass — same reasoning as
// wallets/page.tsx's maxDuration for the same action.
export const maxDuration = 300;

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; hideUnpriced?: string; hideLow?: string }>;
}) {
  const { chain: selectedChain, hideUnpriced, hideLow } = await searchParams;
  const [{ groups, grand }, priceState, user] = await Promise.all([
    getAssetsGroupedByChain(),
    getPriceRefreshState(),
    getUser(),
  ]);

  return (
    <>
      <PageHeader title="Portfolio" subtitle="Every holding across all your wallets, grouped by chain" />

      {user ? (
        <TotalValuePanel
          total={grand.total}
          actions={
            <div className="flex items-center gap-3">
              <form action={syncAllWallets}>
                <SubmitButton variant="secondary" size="sm" pendingLabel="Starting…">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Sync all
                </SubmitButton>
              </form>
              <form action={refreshPricesAction}>
                <SubmitButton variant="secondary" size="sm" pendingLabel="Refreshing prices…">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Refresh prices
                </SubmitButton>
              </form>
              <p className="text-xs text-fg-muted">Last priced: {formatStaleness(priceState.refreshedAt)}</p>
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
          hideUnpriced={hideUnpriced !== "0"}
          hideLow={hideLow !== "0"}
          baseHref="/portfolio"
          emptyMessage="No holdings yet — add or sync a wallet to see your portfolio here."
        />
      )}
    </>
  );
}

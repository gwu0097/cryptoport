import Link from "next/link";
import { getWalletsWithTotals, getTags, getPriceRefreshState, getTokenRegistryState } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PriceRefreshButton } from "@/components/PriceRefreshButton";
import { TokenRegistryRefreshButton } from "@/components/TokenRegistryRefreshButton";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { buttonClass } from "@/components/ui/Button";
import { WalletsTable } from "@/components/WalletsTable";
import { GuestBanner } from "@/components/GuestBanner";
import { SyncAllWalletsButton } from "@/components/SyncAllWalletsButton";
import { WalletsFilterProvider } from "@/components/wallets/WalletsFilterProvider";
import { WalletsTotalValue } from "@/components/wallets/WalletsTotalValue";
import { refreshPricesAction, refreshTokenRegistryAction, syncAllWallets } from "./actions";

// Without this, Next prerenders "/wallets" once at build time (it has no
// runtime APIs or cookies to force dynamic rendering the old way) and Vercel
// would serve that frozen snapshot until the next deploy — wrong for a page
// whose entire job is showing current wallet values.
export const dynamic = "force-dynamic";

// refreshTokenRegistryAction pulls CoinGecko's full coin list (tens of
// thousands of rows across every configured chain) — same reasoning as the
// per-wallet sync's maxDuration in wallets/[id]/page.tsx.
export const maxDuration = 300;

export default async function WalletsPage() {
  const [{ wallets, grand }, tags, priceState, tokenRegistryState, user] = await Promise.all([
    getWalletsWithTotals(),
    getTags(),
    getPriceRefreshState(),
    getTokenRegistryState(),
    getUser(),
  ]);
  const tagNames = tags.map((t) => t.name);

  return (
    // Wraps both the header (SyncAllWalletsButton) and the table below it
    // — the two need to share the same tag-filter state (see
    // WalletsFilterProvider's own doc comment on why a Context, not a
    // restructure, is the right fix for two client components this far
    // apart in a Server Component page).
    <WalletsFilterProvider>
      <PageHeader
        title="Wallets"
        actions={
          user && (
            <>
              <Link href="/wallets/new" className={buttonClass("primary", "sm")}>
                + Add wallet
              </Link>
              <SyncAllWalletsButton wallets={wallets} syncAll={syncAllWallets} />
              <PriceRefreshButton priceState={priceState} refresh={refreshPricesAction} />
              <TokenRegistryRefreshButton tokenRegistryState={tokenRegistryState} refresh={refreshTokenRegistryAction} />
            </>
          )
        }
      />

      {user ? (
        <WalletsTotalValue wallets={wallets} grandTotal={grand.total} grandUnpricedCount={grand.unpricedCount} />
      ) : (
        <GuestBanner message="Sign up or connect a wallet to see your own wallets here." />
      )}

      {wallets.length === 0 ? (
        user ? (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">No wallets yet.</p>
            <Link href="/wallets/new" className={`${buttonClass("primary", "sm")} mt-4`}>
              + Add wallet
            </Link>
          </Panel>
        ) : (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">Log in and add a wallet to see your wallets here.</p>
          </Panel>
        )
      ) : (
        <Panel padding={false} className="overflow-hidden">
          <WalletsTable wallets={wallets} tagNames={tagNames} />
        </Panel>
      )}
    </WalletsFilterProvider>
  );
}

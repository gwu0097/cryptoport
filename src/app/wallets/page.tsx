import Link from "next/link";
import { RefreshCw, Database } from "lucide-react";
import { getWalletsWithTotals, getTags, getPriceRefreshState } from "@/lib/queries";
import { formatStaleness, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { buttonClass } from "@/components/ui/Button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { WalletsTable } from "@/components/WalletsTable";
import { refreshPricesAction, refreshTokenRegistryAction } from "./actions";

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
  const [{ wallets, grand }, tags, priceState] = await Promise.all([
    getWalletsWithTotals(),
    getTags(),
    getPriceRefreshState(),
  ]);
  const tagNames = tags.map((t) => t.name);

  return (
    <>
      <PageHeader
        title="Wallets"
        actions={
          <>
            <Link href="/wallets/new" className={buttonClass("primary", "sm")}>
              + Add wallet
            </Link>
            <div className="flex flex-col items-center gap-1">
              <form action={refreshPricesAction}>
                <SubmitButton variant="secondary" size="sm">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Refresh prices
                </SubmitButton>
              </form>
              <p className="text-xs text-fg-muted">Last priced: {formatStaleness(priceState.refreshedAt)}</p>
            </div>
            <form action={refreshTokenRegistryAction}>
              <SubmitButton variant="secondary" size="sm">
                <Database className="size-3.5" aria-hidden="true" />
                Refresh token list
              </SubmitButton>
            </form>
          </>
        }
      />

      <Panel className="mb-6">
        <p className="text-sm text-fg-muted">Total value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">
          {formatUsd(grand.total)}
        </p>
      </Panel>

      {wallets.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">No wallets yet.</p>
          <Link href="/wallets/new" className={`${buttonClass("primary", "sm")} mt-4`}>
            + Add wallet
          </Link>
        </Panel>
      ) : (
        <Panel padding={false} className="overflow-hidden">
          <WalletsTable wallets={wallets} tagNames={tagNames} />
        </Panel>
      )}
    </>
  );
}

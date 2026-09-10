import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { getWalletsWithTotals } from "@/lib/queries";
import { formatStaleness, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button, buttonClass } from "@/components/ui/Button";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";
import { refreshPricesAction } from "./actions";

// Without this, Next prerenders "/wallets" once at build time (it has no
// runtime APIs or cookies to force dynamic rendering the old way) and Vercel
// would serve that frozen snapshot until the next deploy — wrong for a page
// whose entire job is showing current wallet values.
export const dynamic = "force-dynamic";

export default async function WalletsPage() {
  const { wallets, grand } = await getWalletsWithTotals();

  return (
    <>
      <PageHeader
        title="Wallets"
        actions={
          <>
            <Link href="/wallets/new" className={buttonClass("primary", "sm")}>
              + Add wallet
            </Link>
            <form action={refreshPricesAction}>
              <Button type="submit" variant="secondary" size="sm">
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Refresh prices
              </Button>
            </form>
          </>
        }
      />

      <Panel className="mb-6">
        <p className="text-sm text-fg-muted">Total value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">
          {formatUsd(grand.total)}
        </p>
        {grand.unpricedCount > 0 && (
          <p className="mt-2 text-sm text-warning">
            {grand.unpricedCount} holding{grand.unpricedCount === 1 ? "" : "s"} unpriced and
            excluded from the total ({grand.unpricedTickers.join(", ")})
          </p>
        )}
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
          <table className={tableClass}>
            <thead>
              <tr className={theadRowClass}>
                <th className={thClass}>Name</th>
                <th className={thClass}>Chain</th>
                <th className={thClass}>Account</th>
                <th className={thClass}>Mode</th>
                <th className={thClass}>Value</th>
                <th className={thClass}>Refreshed</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((wallet) => (
                <tr key={wallet.id} className={trClass}>
                  <td className={tdClass}>
                    <Link href={`/wallets/${wallet.id}`} className="text-fg hover:text-accent">
                      {wallet.name}
                    </Link>
                  </td>
                  <td className={tdClass}>
                    <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                      {wallet.chain}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                      {wallet.account}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                      {wallet.mode}
                    </span>
                  </td>
                  <td className={`${tdClass} tabular-nums`}>
                    {wallet.total > 0 ? formatUsd(wallet.total) : null}
                    {wallet.unpricedCount > 0 && (
                      <span className="text-warning"> ({wallet.unpricedCount} unpriced)</span>
                    )}
                    {wallet.total === 0 && wallet.unpricedCount === 0 && "—"}
                  </td>
                  <td className={`${tdClass} text-fg-muted`}>
                    {formatStaleness(wallet.last_refresh_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}

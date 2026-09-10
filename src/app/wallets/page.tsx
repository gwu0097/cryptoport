import Link from "next/link";
import { RefreshCw, Trash, Database, Pencil } from "lucide-react";
import { getWalletsWithTotals } from "@/lib/queries";
import { formatStaleness, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { buttonClass } from "@/components/ui/Button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";
import { deleteWallet, refreshPricesAction, refreshTokenRegistryAction } from "./actions";

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
              <SubmitButton variant="secondary" size="sm">
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Refresh prices
              </SubmitButton>
            </form>
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
          <table className={tableClass}>
            <thead>
              <tr className={theadRowClass}>
                <th className={thClass}>Name</th>
                <th className={thClass}>Chain</th>
                <th className={thClass}>Account</th>
                <th className={thClass}>Mode</th>
                <th className={thClass}>Value</th>
                <th className={thClass}>Refreshed</th>
                <th className={thClass}></th>
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
                    {wallet.total > 0 ? formatUsd(wallet.total) : "—"}
                  </td>
                  <td className={`${tdClass} text-fg-muted`}>
                    {formatStaleness(wallet.last_refresh_at)}
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/wallets/${wallet.id}#edit-wallet`}
                        aria-label={`Edit ${wallet.name}`}
                        className={buttonClass("secondary", "sm")}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </Link>
                      <form action={deleteWallet.bind(null, wallet.id)}>
                        <ConfirmDeleteButton
                          confirmMessage={`Delete "${wallet.name}"? This won't delete its holdings.`}
                          aria-label={`Delete ${wallet.name}`}
                        >
                          <Trash className="size-3.5" aria-hidden="true" />
                        </ConfirmDeleteButton>
                      </form>
                    </div>
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

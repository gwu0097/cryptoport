import Link from "next/link";
import { RefreshCw, Trash, Database } from "lucide-react";
import { getWalletsWithTotals, getTags } from "@/lib/queries";
import { formatStaleness, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { buttonClass } from "@/components/ui/Button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";
import { EditWalletModal } from "@/components/EditWalletModal";
import {
  deleteWallet,
  refreshPricesAction,
  refreshTokenRegistryAction,
  syncWalletHoldings,
  updateWallet,
} from "./actions";

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
  const [{ wallets, grand }, tags] = await Promise.all([getWalletsWithTotals(), getTags()]);
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
                <th className={thClass}>Tag</th>
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
                    {wallet.tag ? (
                      <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                        {wallet.tag.name}
                      </span>
                    ) : (
                      <span className="text-fg-muted">—</span>
                    )}
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
                    {wallet.last_refresh_status === "syncing" ? (
                      <span className="text-fg">Syncing…</span>
                    ) : (
                      formatStaleness(wallet.last_refresh_at)
                    )}
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <EditWalletModal
                        wallet={wallet}
                        tagNames={tagNames}
                        updateWallet={updateWallet.bind(null, wallet.id)}
                      />
                      <form action={deleteWallet.bind(null, wallet.id)}>
                        <ConfirmDeleteButton
                          confirmMessage={`Delete "${wallet.name}"? This won't delete its holdings.`}
                          aria-label={`Delete ${wallet.name}`}
                        >
                          <Trash className="size-3.5" aria-hidden="true" />
                        </ConfirmDeleteButton>
                      </form>
                      {wallet.mode !== "auto" ? (
                        // Same box as the sync button below, just invisible
                        // — reserves its width so manual wallets' edit/delete
                        // icons still line up with auto wallets' below them.
                        <span className={`${buttonClass("secondary", "sm")} invisible`} aria-hidden="true">
                          <RefreshCw className="size-3.5" aria-hidden="true" />
                        </span>
                      ) : wallet.last_refresh_status === "syncing" ? (
                        // A sync already in flight (runs in the background —
                        // see syncWalletHoldings — so the form below returns
                        // almost instantly and would otherwise let a second
                        // click queue up a redundant duplicate sync).
                        <span
                          className={`${buttonClass("secondary", "sm")} cursor-not-allowed opacity-50`}
                          aria-label={`${wallet.name} is syncing`}
                        >
                          <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                        </span>
                      ) : (
                        <form action={syncWalletHoldings.bind(null, wallet.id)}>
                          <SubmitButton
                            variant="secondary"
                            size="sm"
                            aria-label={`Sync ${wallet.name}`}
                          >
                            <RefreshCw className="size-3.5" aria-hidden="true" />
                          </SubmitButton>
                        </form>
                      )}
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

import type { WalletWithTotal } from "@/lib/queries";
import { formatUsd } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";

/**
 * A deliberately separate, minimal component from the real WalletsTable —
 * not that component with an added `readOnly` flag. WalletsTable hardcodes
 * imports of deleteWallet/updateWallet/syncWalletHoldings/
 * syncExchangeHoldings and renders live Edit/Delete/Sync controls per row;
 * threading a flag through all of that to suppress it would mean the
 * admin-only read path shares a component with, and adds conditional
 * complexity to, the one table every real user's own wallet management
 * depends on. This one is read-only by construction: it doesn't import a
 * single mutation function, so there is no path for a click here to ever
 * change another user's data — not "the button is hidden," there is no
 * button.
 */
export function AdminWalletsTable({ wallets }: { wallets: WalletWithTotal[] }) {
  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr className={theadRowClass}>
            <th className={thClass}>Name</th>
            <th className={thClass}>Chain</th>
            <th className={`${thClass} ${hideOnMobileClass}`}>Tags</th>
            <th className={`${thClass} ${hideOnMobileClass}`}>Mode</th>
            <th className={thClass}>Value</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((wallet) => (
            <tr key={wallet.id} className={trClass}>
              <td className={tdClass}>{wallet.name}</td>
              <td className={tdClass}>
                <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">{wallet.chain}</span>
              </td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                {wallet.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {wallet.tags.map((t) => (
                      <span key={t.id} className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                        {t.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-fg-muted">—</span>
                )}
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{wallet.mode}</td>
              <td className={`${tdClass} tabular-nums`}>{wallet.total > 0 ? formatUsd(wallet.total) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

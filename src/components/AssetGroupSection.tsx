import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { AssetGroup } from "@/lib/queries";
import { formatUsd, formatQty } from "@/lib/format";
import { chainDisplayName } from "@/lib/chainNames";
import { TokenIcon } from "./TokenIcon";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "./ui/table";

/**
 * One collapsible section per asset (ticker) — the Assets page's version of
 * ChainGroupedHoldings' per-chain sections, just grouped the other way:
 * summary line is the asset (icon, ticker, total qty/value across every
 * wallet), the nested table is the drill-down of which wallets hold it and
 * how much each contributes. Read-only, same as the rest of this page —
 * editing a holding still happens on its own wallet's detail page.
 */
export function AssetGroupSection({ group }: { group: AssetGroup }) {
  return (
    <details open className="group rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-semibold text-fg">
          <ChevronDown
            className="size-4 text-fg-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
          <TokenIcon ticker={group.ticker} url={group.iconUrl} />
          {group.ticker}
          <span className="text-sm font-normal text-fg-muted">
            ({group.holdings.length} wallet{group.holdings.length === 1 ? "" : "s"})
          </span>
        </span>
        <span className="flex items-center gap-3">
          {group.totalQty !== null && (
            <span className="tabular-nums text-sm text-fg-muted">{formatQty(group.totalQty)}</span>
          )}
          <span className="tabular-nums text-fg">{formatUsd(group.total)}</span>
        </span>
      </summary>
      <div className="border-t border-border">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}>Wallet</th>
              <th className={thClass}>Chain</th>
              <th className={thClass}>Qty</th>
              <th className={thClass}>Value</th>
            </tr>
          </thead>
          <tbody>
            {group.holdings.map((holding) => (
              <tr key={holding.id} className={trClass}>
                <td className={tdClass}>
                  <Link href={`/wallets/${holding.walletId}`} className="text-fg hover:text-accent">
                    {holding.walletName}
                  </Link>
                </td>
                <td className={tdClass}>
                  <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                    {chainDisplayName(holding.chainId)}
                  </span>
                </td>
                <td className={`${tdClass} tabular-nums`}>{formatQty(holding.qty)}</td>
                <td className={`${tdClass} tabular-nums`}>
                  {holding.valuation.kind === "priced" ? (
                    formatUsd(holding.valuation.usd)
                  ) : (
                    <span className="text-warning">unpriced</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

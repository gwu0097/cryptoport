import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { DefiProtocolGroup } from "@/lib/queries";
import { formatUsd, formatQty, formatTicker } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "./ui/table";
import { TokenIcon } from "./TokenIcon";

/**
 * Protocol -> wallet -> asset, three levels deep (see
 * getDefiGroupedByProtocol) — the outer <details> is one per protocol
 * (e.g. "Jupiter Earn"), each containing a small sub-heading per
 * contributing wallet so a position spanning several wallets in the same
 * protocol still reads as one section instead of duplicating the protocol
 * header per wallet. No client-side sort/search (unlike AssetsTable) —
 * not worth the complexity while position counts are this small; revisit
 * if that changes.
 */
export function DefiTable({ groups }: { groups: DefiProtocolGroup[] }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <details key={group.protocol} open className="group rounded-xl border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2 font-semibold text-fg">
              <ChevronDown
                className="size-4 text-fg-muted transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
              {group.protocol}
              <span className="text-sm font-normal text-fg-muted">
                ({group.wallets.length} wallet{group.wallets.length === 1 ? "" : "s"})
              </span>
            </span>
            <span className="tabular-nums text-fg">{formatUsd(group.total)}</span>
          </summary>
          <div className="flex flex-col divide-y divide-border border-t border-border">
            {group.wallets.map((w) => (
              <div key={w.walletId} className="px-5 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <Link href={`/wallets/${w.walletId}`} className="text-sm font-medium text-fg hover:text-accent">
                    {w.walletName}
                  </Link>
                  <span className="tabular-nums text-sm text-fg-muted">{formatUsd(w.total)}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className={tableClass}>
                    <thead>
                      <tr className={theadRowClass}>
                        <th className={thClass}>Asset</th>
                        <th className={`${thClass} ${hideOnMobileClass}`}>Qty</th>
                        <th className={thClass}>Value</th>
                        <th className={thClass}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.positions.map((position) => (
                        <tr key={position.id} className={trClass}>
                          <td className={tdClass}>
                            <div className="flex items-center gap-2">
                              <TokenIcon ticker={position.ticker} url={position.icon_url} />
                              {formatTicker(position.ticker)}
                            </div>
                          </td>
                          <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                            {formatQty(position.qty)}
                          </td>
                          <td className={`${tdClass} tabular-nums`}>
                            {position.valuation.kind === "priced" ? (
                              formatUsd(position.valuation.usd)
                            ) : (
                              <span className="text-warning">unpriced</span>
                            )}
                          </td>
                          <td className={tdClass}>
                            {position.protocol_url && (
                              <a
                                href={position.protocol_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-xs text-fg-muted hover:text-accent"
                              >
                                View <ExternalLink className="size-2.5" aria-hidden="true" />
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

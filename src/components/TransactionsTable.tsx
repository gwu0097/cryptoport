import Link from "next/link";
import { ExternalLink, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, CircleHelp } from "lucide-react";
import type { TransactionRow } from "@/lib/queries";
import { chainDisplayName } from "@/lib/chainNames";
import { formatQty, formatDateTime } from "@/lib/format";
import { TruncatedAddress } from "./TruncatedAddress";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "./ui/table";

const DIRECTION_META = {
  in: { label: "Received", icon: ArrowDownLeft, className: "text-positive" },
  out: { label: "Sent", icon: ArrowUpRight, className: "text-negative" },
  self: { label: "Self", icon: ArrowLeftRight, className: "text-fg-muted" },
  unknown: { label: "Unknown", icon: CircleHelp, className: "text-fg-muted" },
} as const;

function DirectionCell({ direction }: { direction: TransactionRow["direction"] }) {
  const { label, icon: Icon, className } = DIRECTION_META[direction];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${className}`}>
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Plain server-rendered table, no client sort/search — "most recent first"
 * is already the query's own order (getTransactions), and which wallet(s)
 * to show is already decided by TransactionsWalletFilter's ?wallet= param
 * before this component ever renders, so there's no in-page filtering left
 * for a client component to own (unlike AssetsTable, which genuinely needs
 * client state for its own independent sort/search over an already-loaded
 * list).
 */
export function TransactionsTable({
  transactions,
  showWallet,
  timeZone,
}: {
  transactions: TransactionRow[];
  showWallet: boolean;
  /** The user's display timezone (see lib/preferences.ts). */
  timeZone: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className={tableClass}>
        <thead>
          <tr className={theadRowClass}>
            <th className={thClass}>When</th>
            {showWallet && <th className={thClass}>Wallet</th>}
            <th className={`${thClass} ${hideOnMobileClass}`}>Chain</th>
            <th className={thClass}></th>
            <th className={thClass}>Asset</th>
            <th className={thClass}>Amount</th>
            <th className={`${thClass} ${hideOnMobileClass}`}>Counterparty</th>
            <th className={thClass}></th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={`${tx.id}`} className={trClass}>
              <td className={`${tdClass} whitespace-nowrap text-fg-muted`}>{formatDateTime(tx.occurred_at, timeZone)}</td>
              {showWallet && (
                <td className={tdClass}>
                  <Link href={`/wallets/${tx.wallet_id}`} className="text-fg hover:text-accent">
                    {tx.walletName}
                  </Link>
                </td>
              )}
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                  {chainDisplayName(tx.chain)}
                </span>
              </td>
              <td className={tdClass}>
                <DirectionCell direction={tx.direction} />
              </td>
              <td className={`${tdClass} font-medium text-fg`}>{tx.ticker ?? "—"}</td>
              <td className={`${tdClass} tabular-nums`}>{tx.amount !== null ? formatQty(tx.amount) : "—"}</td>
              <td className={`${tdClass} ${hideOnMobileClass}`}>
                {tx.counterparty ? <TruncatedAddress address={tx.counterparty} /> : "—"}
              </td>
              <td className={tdClass}>
                {tx.explorer_url && (
                  <a
                    href={tx.explorer_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on block explorer"
                    aria-label="View on block explorer"
                    className="text-fg-muted transition hover:text-fg"
                  >
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

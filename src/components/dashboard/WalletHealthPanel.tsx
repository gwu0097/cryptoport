import Link from "next/link";
import type { WalletWithTotal } from "@/lib/queries";
import { formatStaleness } from "@/lib/format";
import { walletHealthIssue, type WalletHealthIssue } from "@/lib/dashboard";
import { Panel } from "../ui/Panel";

function issueText(issue: WalletHealthIssue, lastRefreshAt: string | null): string {
  switch (issue.kind) {
    case "never_synced":
      return "Never synced";
    case "stale":
      return `Stale — last synced ${formatStaleness(lastRefreshAt)}`;
    case "failed":
      return issue.status;
  }
}

export function WalletHealthPanel({ wallets }: { wallets: WalletWithTotal[] }) {
  const autoWallets = wallets.filter((w) => w.mode === "auto");
  const flagged = autoWallets
    .map((wallet) => ({ wallet, issue: walletHealthIssue(wallet) }))
    .filter((x): x is { wallet: WalletWithTotal; issue: WalletHealthIssue } => x.issue !== null);

  return (
    <Panel title="Wallet health">
      {autoWallets.length === 0 ? (
        <p className="text-sm text-fg-muted">No auto-synced wallets yet.</p>
      ) : flagged.length === 0 ? (
        <p className="text-sm text-fg-muted">
          All {autoWallets.length} auto-synced wallet{autoWallets.length === 1 ? "" : "s"} up to date.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {flagged.map(({ wallet, issue }) => (
            <li key={wallet.id} className="flex items-center justify-between gap-3">
              <Link href={`/wallets/${wallet.id}`} className="truncate text-sm font-medium text-fg hover:text-accent">
                {wallet.name}
              </Link>
              <span className="shrink-0 text-sm text-warning">{issueText(issue, wallet.last_refresh_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

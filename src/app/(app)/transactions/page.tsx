import { RefreshCw } from "lucide-react";
import { getUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { getTransactions } from "@/lib/queries";
import { hasTransactionCoverage } from "@/lib/adapters/transactionDispatch";
import { formatStaleness } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { TransactionsWalletFilter } from "@/components/TransactionsWalletFilter";
import { TransactionsTable } from "@/components/TransactionsTable";
import { syncWalletTransactions, syncAllWalletTransactions } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transactions · CryptoPort" };

// A wallet spread across every Etherscan-covered EVM chain, or a BTC xpub
// with a full address-format scan, can take a real while — same reasoning
// as wallets/[id]/page.tsx's own maxDuration for the same kind of work.
export const maxDuration = 300;

interface WalletOption {
  id: string;
  name: string;
  chain: string;
  tx_synced_at: string | null;
  tx_sync_status: string | null;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string }>;
}) {
  const { wallet: selectedWalletId } = await searchParams;
  const user = await getUser();

  if (!user) {
    return (
      <>
        <PageHeader title="Transactions" subtitle="On-chain activity across your wallets" />
        <GuestBanner message="Sign up or connect a wallet to see your own transaction history here." />
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">Log in and add a wallet to see your transactions here.</p>
        </Panel>
      </>
    );
  }

  const db = await userDb();
  const { data: walletsData, error: walletsError } = await db
    .from("wallets")
    .select("id, name, chain, tx_synced_at, tx_sync_status")
    .eq("active", true)
    .order("name");
  if (walletsError) throw new Error(`Failed to load wallets: ${walletsError.message}`);
  const wallets = walletsData as WalletOption[];

  const selectedWallet = selectedWalletId ? wallets.find((w) => w.id === selectedWalletId) : undefined;
  const transactions = await getTransactions(selectedWallet?.id);

  const covered = selectedWallet ? hasTransactionCoverage(selectedWallet.chain) : true;

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="On-chain activity across your wallets — synced, not live (see Sync below)."
        actions={
          <div className="flex flex-col items-end gap-1">
            {selectedWallet ? (
              covered ? (
                <form action={syncWalletTransactions.bind(null, selectedWallet.id)}>
                  <SubmitButton variant="secondary" size="sm" pendingLabel="Starting…">
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                    Sync this wallet
                  </SubmitButton>
                </form>
              ) : (
                <span className="text-xs text-fg-muted">Not yet supported for {selectedWallet.chain}</span>
              )
            ) : (
              <form action={syncAllWalletTransactions}>
                <SubmitButton variant="secondary" size="sm" pendingLabel="Starting…">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Sync all
                </SubmitButton>
              </form>
            )}
            {selectedWallet && (
              <p className="text-xs text-fg-muted">
                {selectedWallet.tx_sync_status === "syncing"
                  ? "Syncing…"
                  : `Last synced: ${formatStaleness(selectedWallet.tx_synced_at)}`}
              </p>
            )}
          </div>
        }
      />

      <div className="mb-4">
        <TransactionsWalletFilter wallets={wallets} selected={selectedWallet?.id} />
      </div>

      {!covered && (
        <Panel className="mb-4">
          <p className="text-sm text-fg-muted">
            {selectedWallet!.name} is on {selectedWallet!.chain}, which has no free transaction-history source
            wired up yet — Bitcoin, Solana, and 18 EVM chains are covered so far.
          </p>
        </Panel>
      )}

      {transactions.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">
            {covered
              ? "No synced transactions yet — click Sync above to pull recent history."
              : "Nothing to show for this chain yet."}
          </p>
        </Panel>
      ) : (
        <TransactionsTable transactions={transactions} showWallet={!selectedWallet} />
      )}
    </>
  );
}

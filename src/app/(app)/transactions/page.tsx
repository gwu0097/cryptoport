import { getUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { getTransactions } from "@/lib/queries";
import { hasTransactionCoverage } from "@/lib/adapters/transactionDispatch";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { TransactionsWalletFilter } from "@/components/TransactionsWalletFilter";
import { TransactionsTable } from "@/components/TransactionsTable";
import { TransactionSyncButton } from "@/components/TransactionSyncButton";
import { TransactionSyncAllButton } from "@/components/TransactionSyncAllButton";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";
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
  tx_sync_started_at: string | null;
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
    .select("id, name, chain, tx_synced_at, tx_sync_status, tx_sync_started_at")
    .eq("active", true)
    .order("name");
  if (walletsError) throw new Error(`Failed to load wallets: ${walletsError.message}`);
  const wallets = walletsData as WalletOption[];

  const selectedWallet = selectedWalletId ? wallets.find((w) => w.id === selectedWalletId) : undefined;
  const transactions = await getTransactions(selectedWallet?.id);

  const covered = selectedWallet ? hasTransactionCoverage(selectedWallet.chain) : true;

  return (
    <>
      {selectedWallet && (
        <RecordRecentWallet id={selectedWallet.id} name={selectedWallet.name} namespace="transactionsWallets" />
      )}
      <PageHeader
        title="Transactions"
        subtitle="On-chain activity across your wallets — synced, not live (see Sync below)."
        actions={
          selectedWallet ? (
            covered ? (
              <TransactionSyncButton
                txSyncStatus={selectedWallet.tx_sync_status}
                txSyncStartedAt={selectedWallet.tx_sync_started_at}
                txSyncedAt={selectedWallet.tx_synced_at}
                sync={syncWalletTransactions.bind(null, selectedWallet.id)}
              />
            ) : (
              <span className="text-xs text-fg-muted">Not yet supported for {selectedWallet.chain}</span>
            )
          ) : (
            <TransactionSyncAllButton wallets={wallets} syncAll={syncAllWalletTransactions} />
          )
        }
      />

      <div className="mb-4">
        <TransactionsWalletFilter wallets={wallets} selected={selectedWallet?.id} />
      </div>

      {!covered && (
        <Panel className="mb-4">
          <p className="text-sm text-fg-muted">
            {selectedWallet!.name} is on {selectedWallet!.chain}, which has no free transaction-history source
            wired up yet — Bitcoin, Solana, Cardano, Injective, and 23 EVM chains are covered so far (Avalanche,
            BSC, and Manta are the remaining EVM gaps — no free source found for those).
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

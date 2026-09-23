import { getUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { getTransactions } from "@/lib/queries";
import { hasTransactionCoverage } from "@/lib/adapters/transactionDispatch";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { CheckboxLink } from "@/components/ui/CheckboxLink";
import { TransactionsWalletFilter } from "@/components/TransactionsWalletFilter";
import { TransactionsTable } from "@/components/TransactionsTable";
import { TransactionSyncButton } from "@/components/TransactionSyncButton";
import { TransactionSyncAllButton } from "@/components/TransactionSyncAllButton";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";
import { syncWalletTransactions, syncAllWalletTransactions } from "./actions";
import { getEffectiveTimeZone } from "@/lib/preferences";

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

// $5, not a raw token-quantity threshold — 0.0001 BTC is worth real money,
// 1000 of a near-worthless spam token isn't, so this has to filter on
// *value*, not amount. Reported directly after the first version of this
// (a plain "amount === 0" filter, still catches real zero-value address-
// poisoning spam — see transactions.usdValue's own doc comment) left
// small-but-nonzero dust (0.0001 USDC, etc.) still cluttering the list.
const LOW_VALUE_USD = 5;

// Defaults to hidden (checked). Filters on usdValue < LOW_VALUE_USD only
// when usdValue is a real, resolved number — a transaction whose ticker
// has no current price (usdValue: null) always stays visible regardless
// of this filter, same "unknown is never silently treated as low/zero"
// reasoning as CLAUDE.md's data-correctness rule elsewhere in this app:
// hiding an unpriced transaction would be guessing it's probably
// low-value, not knowing it.
function buildHref(walletId: string | undefined, hideLowValue: boolean): string {
  const params = new URLSearchParams();
  if (walletId) params.set("wallet", walletId);
  if (!hideLowValue) params.set("hideLowValue", "0");
  const qs = params.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string; hideLowValue?: string }>;
}) {
  const { wallet: selectedWalletId, hideLowValue: hideLowValueParam } = await searchParams;
  const hideLowValue = hideLowValueParam !== "0";
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
  const allTransactions = await getTransactions(selectedWallet?.id);
  const isLowValue = (t: (typeof allTransactions)[number]) => t.usdValue !== null && t.usdValue < LOW_VALUE_USD;
  const lowValueCount = allTransactions.filter(isLowValue).length;
  const transactions = hideLowValue ? allTransactions.filter((t) => !isLowValue(t)) : allTransactions;

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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <TransactionsWalletFilter wallets={wallets} selected={selectedWallet?.id} />
        {allTransactions.length > 0 && (
          <CheckboxLink
            href={buildHref(selectedWallet?.id, !hideLowValue)}
            checked={hideLowValue}
            label={`Hide low-value transactions (< $${LOW_VALUE_USD})${lowValueCount > 0 ? ` (${lowValueCount})` : ""}`}
          />
        )}
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
            {allTransactions.length > 0
              ? "Every synced transaction here is low-value — uncheck “Hide low-value transactions” above to see them."
              : covered
                ? "No synced transactions yet — click Sync above to pull recent history."
                : "Nothing to show for this chain yet."}
          </p>
        </Panel>
      ) : (
        <TransactionsTable transactions={transactions} showWallet={!selectedWallet} timeZone={(await getEffectiveTimeZone()).tz} />
      )}
    </>
  );
}

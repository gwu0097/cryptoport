import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Trash, RefreshCw, TriangleAlert } from "lucide-react";
import { getWalletDetail, getTags, getPriceRefreshState, isWalletLinked } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { formatStaleness, formatDuration } from "@/lib/format";
import { isExtendedPublicKey } from "@/lib/adapters/bitcoinXpub";
import { pinnedWalletChain } from "@/lib/walletAuth";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { HoldingsTable } from "@/components/HoldingsTable";
import { TruncatedAddress } from "@/components/TruncatedAddress";
import { EditWalletModal } from "@/components/EditWalletModal";
import { AddHoldingModal } from "@/components/AddHoldingModal";
import { AutoRefreshWhileSyncing } from "@/components/AutoRefreshWhileSyncing";
import { AutoSyncOnMount } from "@/components/AutoSyncOnMount";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";
import { VerifyWalletModal } from "@/components/VerifyWalletModal";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import {
  addHolding,
  deleteWallet,
  refreshPricesForWalletAction,
  syncWalletHoldings,
  updateWallet,
} from "../actions";

// The EVM adapter reads every configured chain via Multicall3 (see
// adapters/multicallEvm.ts) — a wallet spread across all 15 chains can take
// a while even with concurrency limits. Ask Vercel for the longest function
// duration available on the current plan; on plans below that ceiling this
// is silently capped, so a very multi-chain wallet may still need a retry.
export const maxDuration = 300;

export default async function WalletDetailPage(
  props: PageProps<"/wallets/[id]"> & {
    searchParams: Promise<{ chain?: string; hideUnpriced?: string; hideLow?: string; autosync?: string }>;
  },
) {
  const { id } = await props.params;
  const { chain: selectedChain, hideUnpriced, hideLow, autosync } = await props.searchParams;

  // The one page that stays gated — unlike the list pages, there's no
  // meaningful "sign in to see this" empty state for one specific wallet
  // id, so a guest is sent straight to /login instead. Checked before the
  // data fetch below rather than relying on getWalletDetail/getTags'/
  // isWalletLinked's own no-session guards (queries.ts) to merely avoid
  // throwing — this is the UX decision, those are the safety net.
  if (!(await getUser())) redirect("/login");

  const [detail, tags, priceState] = await Promise.all([
    getWalletDetail(id),
    getTags(),
    getPriceRefreshState(),
  ]);
  // A signed-in user hitting a wallet RLS hides (someone else's) still 404s
  // — doesn't leak whether the id exists, unchanged from before this page
  // was reachable by guests at all.
  if (!detail) notFound();

  const { wallet, holdings, chainGroups, total, unpricedCount } = detail;
  const addHoldingForWallet = addHolding.bind(null, wallet.id);
  const tagNames = tags.map((t) => t.name);
  // Only a plain/ambiguous-format xpub scan needs "which address format is
  // this" figured out (and cached) at all — a single address or an
  // unambiguous ypub/zpub never goes through that.
  const isBtcXpub = wallet.chain === "BTC" && !!wallet.address && isExtendedPublicKey(wallet.address);

  // "Link this wallet" — one secp256k1 signature proves a 0x address on
  // every EVM chain (RON, SEI, ARB, ... all resolve to 'ETH' here, same as
  // (auth)/walletActions.ts's dedupe), 'SOL' is the one literal chain value
  // this app uses for Solana. Every other chain (BTC, ADA, ...) has no
  // wallet-auth signature scheme implemented, so the section doesn't render
  // at all there. A sequential fetch after getWalletDetail rather than
  // folded into its own Promise.all above — it depends on the wallet's own
  // chain/address, which aren't known until that query returns; a single
  // indexed lookup isn't worth restructuring queries.ts to avoid.
  const pinnedChain = pinnedWalletChain(wallet.chain);
  const alreadyLinked =
    pinnedChain && wallet.address ? await isWalletLinked(pinnedChain, wallet.address) : false;

  return (
    <>
      <RecordRecentWallet id={wallet.id} name={wallet.name} />
      <AutoRefreshWhileSyncing syncing={wallet.last_refresh_status === "syncing"} />
      <AutoSyncOnMount
        enabled={autosync === "1" && wallet.mode === "auto" && wallet.last_refresh_status !== "syncing"}
        sync={syncWalletHoldings.bind(null, wallet.id, false)}
      />
      <p className="mb-2">
        <Link href="/wallets" className="text-sm text-fg-muted hover:text-fg">
          ← Wallets
        </Link>
      </p>

      {/* items-start (not items-center) + shrink-0 on the actions column is
          what keeps Sync/Delete pinned top-right regardless of how long the
          left column's content gets — a raw xpub/address is one unbreakable
          token with no natural wrap points, which used to force the whole
          header to wrap onto two rows instead of just the text underneath
          it wrapping. TruncatedAddress below removes the giant unbroken
          string entirely, but this stays robust either way. */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h1 className="text-xl font-semibold text-fg">{wallet.name}</h1>
            <EditWalletModal
              wallet={wallet}
              tagNames={tagNames}
              updateWallet={updateWallet.bind(null, wallet.id)}
            />
            {pinnedChain && wallet.address && (alreadyLinked ? (
              <VerifiedBadge />
            ) : (
              <VerifyWalletModal pinnedTarget={{ chain: pinnedChain, address: wallet.address }} />
            ))}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1 text-sm text-fg-muted">
            <span>{wallet.chain}</span>
            {wallet.tag && (
              <>
                <span>·</span>
                <span>{wallet.tag.name}</span>
              </>
            )}
            <span>·</span>
            <span>{wallet.mode}</span>
            {wallet.address && (
              <>
                <span>·</span>
                <TruncatedAddress address={wallet.address} />
              </>
            )}
            {wallet.last_refresh_status?.startsWith("partial") && (
              // Native `title` tooltip, not a full-text paragraph — a
              // handful of unverified balance checks (see
              // multicallEvm.ts's unverifiedCount) is expected noise from
              // free RPC providers at this scale, not something wrong with
              // the sync. Full detail is still one hover away. (title has
              // to live on a wrapping element — lucide-react's icon props
              // don't pass it through to the underlying <svg>.)
              <span
                className="inline-block align-text-bottom"
                title={wallet.last_refresh_status}
                aria-label={wallet.last_refresh_status}
              >
                <TriangleAlert className="size-3.5 text-warning" aria-hidden="true" />
              </span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {wallet.mode === "auto" &&
              (wallet.last_refresh_status === "syncing" ? (
                // A sync already in flight (runs in the background — see
                // syncWalletHoldings — so a fresh click would otherwise
                // queue up a redundant duplicate sync).
                <span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-fg opacity-50">
                  <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                  Syncing…
                </span>
              ) : (
                <>
                  <form action={syncWalletHoldings.bind(null, wallet.id, false)}>
                    <SubmitButton variant="secondary" size="sm">
                      <RefreshCw className="size-3.5" aria-hidden="true" />
                      Sync holdings
                    </SubmitButton>
                  </form>
                  {/* Only worth offering once a cache exists to override —
                      without one, plain "Sync holdings" already does the
                      full check. For e.g. a wallet that switched address
                      format and needs re-detecting. */}
                  {isBtcXpub && wallet.btc_script_type && (
                    <form action={syncWalletHoldings.bind(null, wallet.id, true)}>
                      <SubmitButton
                        variant="secondary"
                        size="sm"
                        title="Re-check all address formats instead of using the cached one — use this if the wallet's address format changed."
                      >
                        Full sync
                      </SubmitButton>
                    </form>
                  )}
                </>
              ))}
            <div className="flex flex-col items-center gap-1">
              <form action={refreshPricesForWalletAction.bind(null, wallet.id)}>
                <SubmitButton variant="secondary" size="sm">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Refresh prices
                </SubmitButton>
              </form>
              <p className="text-xs text-fg-muted">Last priced: {formatStaleness(priceState.refreshedAt)}</p>
            </div>
            <form action={deleteWallet.bind(null, wallet.id)}>
              <ConfirmDeleteButton
                confirmMessage={`Delete "${wallet.name}"? This won't delete its holdings.`}
              >
                <Trash className="size-3.5" aria-hidden="true" />
                Delete wallet
              </ConfirmDeleteButton>
            </form>
          </div>
          <p className="text-xs text-fg-muted">
            {wallet.last_refresh_status === "syncing" ? (
              "Syncing…"
            ) : (
              <>
                Synced: {formatStaleness(wallet.last_refresh_at)}
                {wallet.last_sync_duration_ms !== null && (
                  <> · took {formatDuration(wallet.last_sync_duration_ms)}</>
                )}
              </>
            )}
          </p>
          {isBtcXpub && !wallet.btc_script_type && wallet.last_refresh_status !== "syncing" && (
            <p className="max-w-xs text-right text-xs text-fg-muted">
              First sync checks all 3 Bitcoin address formats and can take a few minutes — once it
              finds where your funds are, every sync after that will be much faster.
            </p>
          )}
        </div>
      </div>

      <TotalValuePanel total={total}>
        {unpricedCount > 0 && (
          <p className="mt-2 text-sm text-warning">
            {unpricedCount} holding{unpricedCount === 1 ? "" : "s"} unpriced and excluded from the
            total
          </p>
        )}
        {wallet.last_refresh_status?.startsWith("error:") && (
          <p className="mt-2 text-sm text-negative">Last sync failed: {wallet.last_refresh_status}</p>
        )}
        {wallet.notes && <p className="mt-2 text-sm text-fg-muted">{wallet.notes}</p>}
      </TotalValuePanel>

      {wallet.mode === "auto" ? (
        <div className="mb-6">
          <ChainGroupedHoldings
            groups={chainGroups}
            grandTotal={total}
            selectedChain={selectedChain}
            hideUnpriced={hideUnpriced !== "0"}
            hideLow={hideLow !== "0"}
            baseHref={`/wallets/${wallet.id}`}
            emptyMessage="No holdings yet — click “Sync holdings” above."
            walletId={wallet.id}
            actions={<AddHoldingModal addHolding={addHoldingForWallet} />}
          />
        </div>
      ) : (
        <>
        <div className="mb-4">
          <AddHoldingModal addHolding={addHoldingForWallet} defaultTicker={wallet.chain} />
        </div>
        {holdings.length === 0 ? (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">No holdings yet.</p>
          </Panel>
        ) : (
          <Panel padding={false} className="mb-6 overflow-hidden">
            <HoldingsTable holdings={holdings} walletId={wallet.id} />
          </Panel>
        )}
        </>
      )}
    </>
  );
}

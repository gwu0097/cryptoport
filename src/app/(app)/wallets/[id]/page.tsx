import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Trash, TriangleAlert, ExternalLink } from "lucide-react";
import { getWalletDetail, getTags, getPriceRefreshState, isWalletLinked } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { getWalletUnrecognizedTokens } from "@/lib/unrecognizedTokensQuery";
import { UnrecognizedTokensPanel } from "@/components/wallets/UnrecognizedTokensPanel";
import { isExtendedPublicKey, pinnedWalletChain, externalPortfolioViewer } from "@/lib/walletDisplay";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { HoldingsTable } from "@/components/HoldingsTable";
import { TruncatedAddress } from "@/components/TruncatedAddress";
import { EditWalletModal } from "@/components/EditWalletModal";
import { AddHoldingModal } from "@/components/AddHoldingModal";
import { AutoSyncOnMount } from "@/components/AutoSyncOnMount";
import { PriceRefreshButton } from "@/components/PriceRefreshButton";
import { SyncWalletButtons } from "@/components/SyncWalletButtons";
import { SyncExchangeButton } from "@/components/SyncExchangeButton";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";
import { VerifyWalletModal } from "@/components/VerifyWalletModal";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import {
  addHolding,
  deleteWallet,
  disconnectExchange,
  refreshPricesForWalletAction,
  syncWalletHoldings,
  syncExchangeHoldings,
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
    searchParams: Promise<{
      chain?: string;
      protocol?: string;
      hideUnpriced?: string;
      hideLow?: string;
      autosync?: string;
    }>;
  },
) {
  const { id } = await props.params;
  const { chain: selectedChain, protocol: selectedProtocol, hideUnpriced, hideLow, autosync } = await props.searchParams;

  // The one page that stays gated — unlike the list pages, there's no
  // meaningful "sign in to see this" empty state for one specific wallet
  // id, so a guest is sent straight to /login instead. Checked before the
  // data fetch below rather than relying on getWalletDetail/getTags'/
  // isWalletLinked's own no-session guards (queries.ts) to merely avoid
  // throwing — this is the UX decision, those are the safety net.
  if (!(await getUser())) redirect("/login");

  const [detail, tags, priceState, unrecognized] = await Promise.all([
    getWalletDetail(id),
    getTags(),
    getPriceRefreshState(),
    getWalletUnrecognizedTokens(id),
  ]);
  // A signed-in user hitting a wallet RLS hides (someone else's) still 404s
  // — doesn't leak whether the id exists, unchanged from before this page
  // was reachable by guests at all.
  if (!detail) notFound();

  const { wallet, holdings, chainGroups, total, unpricedCount } = detail;
  const addHoldingForWallet = addHolding.bind(null, wallet.id);
  const unrecognizedSpam = unrecognized.filter((t) => t.spam).length;
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
  const externalViewer = wallet.address ? externalPortfolioViewer(wallet.chain, wallet.address) : null;

  return (
    <>
      <RecordRecentWallet id={wallet.id} name={wallet.name} />
      <AutoSyncOnMount
        enabled={autosync === "1" && wallet.mode === "auto"}
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
          string entirely, but this stays robust either way. flex-wrap
          (matches PageHeader's own header row) is required too — without
          it, on a narrow viewport the shrink-0 actions column refused to
          shrink and min-w-0 let the title column get squeezed down to a
          near-zero width instead, wrapping the wallet name one word per
          line and burying the edit/verify/external-link icons under the
          action buttons. With flex-wrap, the actions column drops to its
          own row below the title once it no longer fits alongside it. */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
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
            {externalViewer && (
              <a
                href={externalViewer.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`View on ${externalViewer.label}`}
                aria-label={`View on ${externalViewer.label}`}
                className="text-fg-muted transition hover:text-fg"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1 text-sm text-fg-muted">
            <span>{wallet.chain}</span>
            {wallet.tags.length > 0 && (
              <>
                <span>·</span>
                <span>{wallet.tags.map((t) => t.name).join(", ")}</span>
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

        <div className="flex w-full flex-col items-end gap-2 sm:w-auto sm:shrink-0">
          <div className="flex flex-wrap items-start justify-end gap-2">
            {wallet.provider ? (
              // A connected exchange has no on-chain address to scan — just
              // its own independent balances job
              // (see SyncExchangeButton's own doc comment) and a disconnect
              // action instead of the regular delete/sync UI below.
              <SyncExchangeButton
                exchangeSyncStatus={wallet.exchange_sync_status}
                exchangeSyncStartedAt={wallet.exchange_sync_started_at}
                exchangeSyncedAt={wallet.exchange_synced_at}
                sync={syncExchangeHoldings.bind(null, wallet.id)}
              />
            ) : (
              <>
                {wallet.mode === "auto" ? (
                  // No separate "Refresh prices" button for an auto wallet —
                  // syncWalletHoldings now always prices this wallet's own
                  // holdings' price_keys as part of every sync (see its own
                  // doc comment in wallets/actions.ts), so Sync is a strict
                  // superset of what a scoped refresh button would add here.
                  <SyncWalletButtons
                    lastRefreshStatus={wallet.last_refresh_status}
                    syncStartedAt={wallet.sync_started_at}
                    lastRefreshAt={wallet.last_refresh_at}
                    lastSyncDurationMs={wallet.last_sync_duration_ms}
                    sync={syncWalletHoldings.bind(null, wallet.id, false)}
                    fullSync={
                      isBtcXpub && wallet.btc_script_type ? syncWalletHoldings.bind(null, wallet.id, true) : null
                    }
                  />
                ) : null}
                {wallet.mode !== "auto" && (
                  // A manual wallet has no Sync action at all — addHolding
                  // reprices a brand-new ticker at add time, but this is still
                  // the only way to freshen an already-known ticker's price
                  // from this page (same reasoning as the other price-consumer
                  // pages that keep this button).
                  <PriceRefreshButton
                    priceState={priceState}
                    refresh={refreshPricesForWalletAction.bind(null, wallet.id)}
                  />
                )}
              </>
            )}
            <form action={(wallet.provider ? disconnectExchange : deleteWallet).bind(null, wallet.id)}>
              <ConfirmDeleteButton
                confirmMessage={
                  wallet.provider
                    ? `Disconnect "${wallet.name}"? This removes the stored key from CryptoPort, but Coinbase doesn't let apps revoke a key remotely — delete it from Coinbase's own portal too if you want it fully dead.`
                    : `Delete "${wallet.name}"? This won't delete its holdings.`
                }
              >
                <Trash className="size-3.5" aria-hidden="true" />
                {wallet.provider ? "Disconnect" : "Delete wallet"}
              </ConfirmDeleteButton>
            </form>
          </div>
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
        {unrecognized.length > 0 && (
          <p className="mt-2 text-sm text-fg-muted">
            <a href="#unrecognized" className="hover:text-fg hover:underline">
              {unrecognized.length} unrecognized token{unrecognized.length === 1 ? "" : "s"} not included
              {unrecognizedSpam > 0 && ` (${unrecognizedSpam === unrecognized.length ? "all" : unrecognizedSpam} look like spam)`}
            </a>
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
            selectedProtocol={selectedProtocol}
            hideUnpriced={hideUnpriced !== "0"}
            hideLow={hideLow !== "0"}
            baseHref={`/wallets/${wallet.id}`}
            emptyMessage="No holdings yet — click “Sync holdings” above."
            walletId={wallet.id}
            actions={<AddHoldingModal addHolding={addHoldingForWallet} />}
          />
        </div>
      ) : null}
      {wallet.mode === "auto" && unrecognized.length > 0 ? <UnrecognizedTokensPanel tokens={unrecognized} /> : null}
      {wallet.mode === "auto" ? null : (
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

import { ConnectNearCom } from "@/components/ConnectNearCom";
import { NEARCOM } from "@/lib/nearIntents";
import Link from "next/link";
import { getChainIconMap, scopePricesToUser } from "@/lib/queries";
import { notFound, redirect } from "next/navigation";
import { Trash, TriangleAlert, ExternalLink } from "lucide-react";
import { getWalletDetail, getTags, getPriceRefreshState, isWalletLinked } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { getWalletUnrecognizedTokens } from "@/lib/unrecognizedTokensQuery";
import { UnrecognizedTokensPanel } from "@/components/wallets/UnrecognizedTokensPanel";
import { isExtendedPublicKey, pinnedWalletChain, externalPortfolioViewer } from "@/lib/walletDisplay";
import { Panel } from "@/components/ui/Panel";
import { TotalValueFigure } from "@/components/TotalValuePanel";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { isSyncNote } from "@/lib/syncNotes";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { HoldingsTable } from "@/components/HoldingsTable";
import { toHoldingRows } from "@/lib/holdingRows";
import { WalletTags } from "@/components/WalletTags";
import { TruncatedAddress } from "@/components/TruncatedAddress";
import { EditWalletModal } from "@/components/EditWalletModal";
import { InlineName } from "@/components/ui/InlineName";
import { AutoSyncToggle } from "@/components/wallets/AutoSyncToggle";
import { canAutoSync } from "@/lib/autoSync";
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
  syncWalletHoldings,
  syncExchangeHoldings,
  updateWallet,
  renameWallet,
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
  scopePricesToUser(); // prices for the user's own coins only (docs/perf/PRICES_READ.md)
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
    // The holdings table's chain icons (cached per request), so they don't
    // wait behind the linked-wallet check below.
    getChainIconMap(),
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

      {/* One header card (Fable, 2026-09-30; the influencer page's shape):
          who the wallet is left, its total in the middle, the sync job right
          with its own status; rare switches and delete in the footer. */}
      <Panel
        className="mb-4"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            {canAutoSync(wallet) ? <AutoSyncToggle walletId={wallet.id} on={wallet.auto_sync === true} /> : <span />}
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
        }
      >
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1">
              <h1 className="text-xl font-semibold text-fg">
                <InlineName name={wallet.name} inputClassName="text-lg font-semibold" onSave={renameWallet.bind(null, wallet.id)} />
              </h1>
              <EditWalletModal wallet={wallet} tagNames={tagNames} updateWallet={updateWallet.bind(null, wallet.id)} settingsIcon />
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
              <span>·</span>
              <span>{wallet.mode}</span>
              {wallet.address && (
                <>
                  <span>·</span>
                  <TruncatedAddress address={wallet.address} />
                </>
              )}
              {wallet.last_refresh_status?.startsWith("partial") && (
                // A few unverified balance checks are expected noise from
                // free RPCs; the detail is one hover away. (title lives on a
                // wrapper — lucide icons don't pass it to the <svg>.)
                <span className="inline-block align-text-bottom" title={wallet.last_refresh_status} aria-label={wallet.last_refresh_status}>
                  <TriangleAlert className="size-3.5 text-warning" aria-hidden="true" />
                </span>
              )}
            </p>
            <div className="mt-2">
              <WalletTags walletId={wallet.id} tags={wallet.tags.map((t) => t.name)} allTags={tagNames} />
            </div>
          </div>

          <div className="min-w-0">
            <TotalValueFigure
              total={total}
              label={
                <>
                  Total value
                  {isSyncNote(wallet.notes) && <InfoTooltip>{wallet.notes}</InfoTooltip>}
                </>
              }
            />
            {unpricedCount > 0 && (
              <p className="mt-1 text-xs text-warning">
                {unpricedCount} holding{unpricedCount === 1 ? "" : "s"} unpriced and excluded from the total
              </p>
            )}
            {unrecognized.length > 0 && (
              <p className="mt-1 text-xs text-fg-muted">
                <a href="#unrecognized" className="hover:text-fg hover:underline">
                  {unrecognized.length} unrecognized token{unrecognized.length === 1 ? "" : "s"} not included
                  {unrecognizedSpam > 0 && ` (${unrecognizedSpam === unrecognized.length ? "all" : unrecognizedSpam} look like spam)`}
                </a>
              </p>
            )}
            {wallet.last_refresh_status?.startsWith("error:") && <SyncError status={wallet.last_refresh_status} />}
            {wallet.notes && !isSyncNote(wallet.notes) && <p className="mt-1 text-xs text-fg-muted">{wallet.notes}</p>}
          </div>

          <div className="flex flex-col items-start gap-2 md:items-end">
            {wallet.provider ? (
              // A connected exchange has no address to scan — its own
              // balances job (SyncExchangeButton).
              <>
                <SyncExchangeButton
                  exchangeSyncStatus={wallet.exchange_sync_status}
                  exchangeSyncStartedAt={wallet.exchange_sync_started_at}
                  exchangeSyncedAt={wallet.exchange_synced_at}
                  sync={syncExchangeHoldings.bind(null, wallet.id)}
                />
                {/* near.com's token lasts 30 days: a fresh signature renews it. */}
                {wallet.provider === NEARCOM && <ConnectNearCom walletId={wallet.id} />}
              </>
            ) : wallet.mode === "auto" ? (
              // Sync also prices this wallet's own coins, so there's no
              // separate Refresh prices here.
              <SyncWalletButtons
                lastRefreshStatus={wallet.last_refresh_status}
                syncStartedAt={wallet.sync_started_at}
                lastRefreshAt={wallet.last_refresh_at}
                lastSyncDurationMs={wallet.last_sync_duration_ms}
                sync={syncWalletHoldings.bind(null, wallet.id, false)}
                fullSync={isBtcXpub && wallet.btc_script_type ? syncWalletHoldings.bind(null, wallet.id, true) : null}
              />
            ) : (
              // A manual wallet has no sync: this is how its known coins get
              // a fresh price from here.
              <PriceRefreshButton priceState={priceState} walletId={wallet.id} />
            )}
            {isBtcXpub && !wallet.btc_script_type && wallet.last_refresh_status !== "syncing" && (
              <p className="max-w-xs text-xs text-fg-muted md:text-right">
                First sync checks all 3 Bitcoin address formats and can take a few minutes; later syncs are much faster.
              </p>
            )}
          </div>
        </div>
      </Panel>

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
        <Panel
          padding={false}
          className="mb-6 overflow-hidden [&>div:first-child]:px-5 [&>div:first-child]:pt-4"
          title="Holdings"
          actions={<AddHoldingModal addHolding={addHoldingForWallet} defaultTicker={wallet.chain} />}
        >
          {holdings.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-fg-muted">No holdings yet.</p>
          ) : (
            <HoldingsTable holdings={toHoldingRows(holdings)} walletId={wallet.id} />
          )}
        </Panel>
      )}
    </>
  );
}

/** A failed sync's message: one short line, the rest behind "details" — a
 * failure on every chain once filled the header with 40 chains' errors
 * (2026-10-08). */
function SyncError({ status }: { status: string }) {
  const text = status.replace(/^error:\s*/, "");
  if (text.length <= 160) return <p className="mt-1 break-words text-xs text-negative">Last sync failed: {text}</p>;
  return (
    <details className="mt-1 text-xs text-negative">
      <summary className="cursor-pointer break-words">Last sync failed: {text.slice(0, 140)}… <span className="text-fg-muted underline">details</span></summary>
      <p className="mt-1 max-h-48 overflow-y-auto break-all text-fg-muted">{text}</p>
    </details>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash, RefreshCw, TriangleAlert } from "lucide-react";
import { getWalletDetail, getTags, getPriceRefreshState, type HoldingWithValuation } from "@/lib/queries";
import { formatStaleness, formatUsd, formatQty, formatTicker, formatDuration } from "@/lib/format";
import { isExtendedPublicKey } from "@/lib/adapters/bitcoinXpub";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { inputClass } from "@/components/ui/Field";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { TokenIcon } from "@/components/TokenIcon";
import { TruncatedAddress } from "@/components/TruncatedAddress";
import { EditWalletModal } from "@/components/EditWalletModal";
import { AddHoldingModal } from "@/components/AddHoldingModal";
import { AutoRefreshWhileSyncing } from "@/components/AutoRefreshWhileSyncing";
import {
  addHolding,
  deleteHolding,
  deleteWallet,
  refreshPricesForWalletAction,
  syncWalletHoldings,
  updateHolding,
  updateWallet,
} from "../actions";

// The EVM adapter reads every configured chain via Multicall3 (see
// adapters/multicallEvm.ts) — a wallet spread across all 15 chains can take
// a while even with concurrency limits. Ask Vercel for the longest function
// duration available on the current plan; on plans below that ceiling this
// is silently capped, so a very multi-chain wallet may still need a retry.
export const maxDuration = 300;

function ValueCell({ holding }: { holding: HoldingWithValuation }) {
  if (holding.valuation.kind === "unpriced") {
    return <span className="text-warning">unpriced</span>;
  }
  return <>{formatUsd(holding.valuation.usd)}</>;
}

function EditForm({ holding, walletId }: { holding: HoldingWithValuation; walletId: string }) {
  const update = updateHolding.bind(null, holding.id, walletId);
  return (
    <form action={update} className="flex items-center gap-2">
      {holding.source === "manual_usd" ? (
        <input
          name="usd_override"
          type="text"
          inputMode="decimal"
          defaultValue={holding.usd_override ?? ""}
          className={`${inputClass} w-28`}
        />
      ) : (
        <input
          name="qty"
          type="text"
          inputMode="decimal"
          defaultValue={holding.qty ?? ""}
          className={`${inputClass} w-28`}
        />
      )}
      <SubmitButton variant="secondary" size="sm">
        Save
      </SubmitButton>
    </form>
  );
}

export default async function WalletDetailPage(
  props: PageProps<"/wallets/[id]"> & {
    searchParams: Promise<{ chain?: string; hideUnpriced?: string; hideLow?: string }>;
  },
) {
  const { id } = await props.params;
  const { chain: selectedChain, hideUnpriced, hideLow } = await props.searchParams;
  const [detail, tags, priceState] = await Promise.all([
    getWalletDetail(id),
    getTags(),
    getPriceRefreshState(),
  ]);
  if (!detail) notFound();

  const { wallet, holdings, chainGroups, total, unpricedCount } = detail;
  const addHoldingForWallet = addHolding.bind(null, wallet.id);
  const tagNames = tags.map((t) => t.name);
  // Only a plain/ambiguous-format xpub scan needs "which address format is
  // this" figured out (and cached) at all — a single address or an
  // unambiguous ypub/zpub never goes through that.
  const isBtcXpub = wallet.chain === "BTC" && !!wallet.address && isExtendedPublicKey(wallet.address);

  return (
    <>
      <AutoRefreshWhileSyncing syncing={wallet.last_refresh_status === "syncing"} />
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

      <Panel className="mb-6">
        <p className="text-sm text-fg-muted">Total value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">{formatUsd(total)}</p>
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
      </Panel>

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
        <Panel padding={false} className="mb-6 overflow-hidden">
          <table className={tableClass}>
            <thead>
              <tr className={theadRowClass}>
                <th className={thClass}>Ticker</th>
                <th className={thClass}>Qty</th>
                <th className={thClass}>Price</th>
                <th className={thClass}>Value</th>
                <th className={thClass}>Source</th>
                <th className={thClass}>Category</th>
                <th className={thClass}></th>
              </tr>
            </thead>
            <tbody>
              {holdings.length === 0 && (
                <tr>
                  <td colSpan={7} className={`${tdClass} text-fg-muted`}>
                    No holdings yet.
                  </td>
                </tr>
              )}
              {holdings.map((holding) => (
                <tr key={holding.id} className={trClass}>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <TokenIcon ticker={holding.ticker} url={holding.icon_url} />
                      {formatTicker(holding.ticker)}
                    </div>
                  </td>
                  <td className={`${tdClass} tabular-nums`}>{formatQty(holding.qty)}</td>
                  <td className={`${tdClass} tabular-nums`}>
                    {holding.source === "manual_usd" ? "—" : (holding.price ?? "unpriced")}
                  </td>
                  <td className={`${tdClass} tabular-nums`}>
                    <ValueCell holding={holding} />
                  </td>
                  <td className={tdClass}>
                    <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                      {holding.source}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                      {holding.category}
                    </span>
                  </td>
                  <td className={tdClass}>
                    {holding.source === "auto" ? null : (
                      <div className="flex items-center gap-2">
                        <EditForm holding={holding} walletId={wallet.id} />
                        <form action={deleteHolding.bind(null, holding.id, wallet.id)}>
                          <ConfirmDeleteButton
                            confirmMessage={`Delete the ${holding.ticker} holding?`}
                            aria-label="Delete holding"
                          >
                            <Trash className="size-3.5" aria-hidden="true" />
                          </ConfirmDeleteButton>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        </>
      )}
    </>
  );
}

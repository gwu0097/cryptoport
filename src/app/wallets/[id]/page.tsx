import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash, RefreshCw, TriangleAlert, ChevronDown } from "lucide-react";
import { getWalletDetail, type HoldingWithValuation } from "@/lib/queries";
import { formatStaleness, formatUsd, formatQty, formatTicker } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { Field, inputClass, selectClass } from "@/components/ui/Field";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { TokenIcon } from "@/components/TokenIcon";
import type { Wallet } from "@/lib/types";
import {
  addHolding,
  deleteHolding,
  deleteWallet,
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

function EditWalletDetails({ wallet }: { wallet: Wallet }) {
  const update = updateWallet.bind(null, wallet.id);
  return (
    <details className="group mb-6 rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className="size-4 text-fg-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
        Edit wallet
      </summary>
      <div className="border-t border-border p-5">
        <form action={update} className="flex flex-col gap-4">
          <Field label="Name">
            <input name="name" type="text" required defaultValue={wallet.name} className={inputClass} />
          </Field>

          <Field label="Chain">
            <select name="chain" required defaultValue={wallet.chain} className={selectClass}>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="SOL">SOL</option>
            </select>
          </Field>

          <Field label="Mode">
            <select name="mode" required defaultValue={wallet.mode} className={selectClass}>
              <option value="manual">manual — enter holdings by hand</option>
              <option value="auto">auto — adapter fetches holdings</option>
            </select>
          </Field>

          <Field label="Account">
            <select name="account" defaultValue={wallet.account} className={selectClass}>
              <option value="personal">personal</option>
              <option value="biz">biz</option>
            </select>
          </Field>

          <Field
            label="Address"
            hint="For auto BTC: an xpub/ypub/zpub scans the whole HD wallet account, not just one address."
          >
            <input name="address" type="text" defaultValue={wallet.address ?? ""} className={inputClass} />
          </Field>

          <SubmitButton className="self-start">Save changes</SubmitButton>
        </form>
      </div>
    </details>
  );
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
  const detail = await getWalletDetail(id);
  if (!detail) notFound();

  const { wallet, holdings, chainGroups, total, unpricedCount } = detail;
  const addHoldingForWallet = addHolding.bind(null, wallet.id);

  return (
    <>
      <p className="mb-2">
        <Link href="/wallets" className="text-sm text-fg-muted hover:text-fg">
          ← Wallets
        </Link>
      </p>

      <PageHeader
        title={wallet.name}
        subtitle={
          <>
            {wallet.chain} · {wallet.account} · {wallet.mode}
            {wallet.address && <> · {wallet.address}</>}
            {" · "}Refreshed: {formatStaleness(wallet.last_refresh_at)}
            {wallet.last_refresh_status?.startsWith("partial") && (
              // Native `title` tooltip, not a full-text paragraph — a
              // handful of unverified balance checks (see
              // multicallEvm.ts's unverifiedCount) is expected noise from
              // free RPC providers at this scale, not something wrong with
              // the sync. Full detail is still one hover away. (title has
              // to live on a wrapping element — lucide-react's icon props
              // don't pass it through to the underlying <svg>.)
              <span
                className="ml-1 inline-block align-text-bottom"
                title={wallet.last_refresh_status}
                aria-label={wallet.last_refresh_status}
              >
                <TriangleAlert className="size-3.5 text-warning" aria-hidden="true" />
              </span>
            )}
          </>
        }
        actions={
          <>
            {wallet.mode === "auto" && (
              <form action={syncWalletHoldings.bind(null, wallet.id)}>
                <SubmitButton variant="secondary" size="sm">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Sync holdings
                </SubmitButton>
              </form>
            )}
            <form action={deleteWallet.bind(null, wallet.id)}>
              <ConfirmDeleteButton
                confirmMessage={`Delete "${wallet.name}"? This won't delete its holdings.`}
              >
                <Trash className="size-3.5" aria-hidden="true" />
                Delete wallet
              </ConfirmDeleteButton>
            </form>
          </>
        }
      />

      <EditWalletDetails wallet={wallet} />

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
          />
        </div>
      ) : (
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
      )}

      {wallet.mode === "manual" ? (
        <>
          <h2 className="mb-3 text-base font-semibold text-fg">Add holding</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Panel>
              <form action={addHoldingForWallet} className="flex flex-col gap-3">
                <input type="hidden" name="kind" value="qty" />
                <Field label="Ticker">
                  <input
                    name="ticker"
                    type="text"
                    required
                    defaultValue={wallet.chain}
                    className={inputClass}
                  />
                </Field>
                <Field label="Quantity">
                  <input
                    name="qty"
                    type="text"
                    inputMode="decimal"
                    required
                    className={inputClass}
                  />
                </Field>
                <SubmitButton className="self-start">Add by quantity</SubmitButton>
              </form>
            </Panel>

            <Panel>
              <form action={addHoldingForWallet} className="flex flex-col gap-3">
                <input type="hidden" name="kind" value="usd" />
                <Field label="Ticker">
                  <input name="ticker" type="text" required className={inputClass} />
                </Field>
                <Field label="Fixed USD value">
                  <input
                    name="usd_override"
                    type="text"
                    inputMode="decimal"
                    required
                    className={inputClass}
                  />
                </Field>
                <SubmitButton className="self-start">Add fixed USD value</SubmitButton>
              </form>
            </Panel>
          </div>
        </>
      ) : (
        <p className="text-sm text-fg-muted">
          This wallet&apos;s holdings come from &ldquo;Sync holdings&rdquo; above, not manual
          entry.
        </p>
      )}
    </>
  );
}

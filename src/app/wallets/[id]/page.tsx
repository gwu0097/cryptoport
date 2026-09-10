import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash } from "lucide-react";
import { getWalletDetail, type HoldingWithValuation } from "@/lib/queries";
import { formatStaleness, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, inputClass } from "@/components/ui/Field";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";
import { addHolding, deleteHolding, updateHolding } from "../actions";

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
      <Button type="submit" variant="secondary" size="sm">
        Save
      </Button>
    </form>
  );
}

export default async function WalletDetailPage(props: PageProps<"/wallets/[id]">) {
  const { id } = await props.params;
  const detail = await getWalletDetail(id);
  if (!detail) notFound();

  const { wallet, holdings, total, unpricedCount } = detail;
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
          </>
        }
      />

      <Panel className="mb-6">
        <p className="text-sm text-fg-muted">Total value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">{formatUsd(total)}</p>
        {unpricedCount > 0 && (
          <p className="mt-2 text-sm text-warning">
            {unpricedCount} holding{unpricedCount === 1 ? "" : "s"} unpriced and excluded from the
            total
          </p>
        )}
      </Panel>

      <Panel padding={false} className="mb-6 overflow-hidden">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}>Ticker</th>
              <th className={thClass}>Qty</th>
              <th className={thClass}>Price</th>
              <th className={thClass}>Value</th>
              <th className={thClass}>Source</th>
              <th className={thClass}></th>
            </tr>
          </thead>
          <tbody>
            {holdings.length === 0 && (
              <tr>
                <td colSpan={6} className={`${tdClass} text-fg-muted`}>
                  No holdings yet.
                </td>
              </tr>
            )}
            {holdings.map((holding) => (
              <tr key={holding.id} className={trClass}>
                <td className={tdClass}>{holding.ticker}</td>
                <td className={`${tdClass} tabular-nums`}>{holding.qty ?? "—"}</td>
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
                  {holding.source === "auto" ? null : (
                    <div className="flex items-center gap-2">
                      <EditForm holding={holding} walletId={wallet.id} />
                      <form action={deleteHolding.bind(null, holding.id, wallet.id)}>
                        <Button type="submit" variant="danger" size="sm" aria-label="Delete holding">
                          <Trash className="size-3.5" aria-hidden="true" />
                        </Button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

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
              <input name="qty" type="text" inputMode="decimal" required className={inputClass} />
            </Field>
            <Button type="submit" className="self-start">
              Add by quantity
            </Button>
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
            <Button type="submit" className="self-start">
              Add fixed USD value
            </Button>
          </form>
        </Panel>
      </div>
    </>
  );
}

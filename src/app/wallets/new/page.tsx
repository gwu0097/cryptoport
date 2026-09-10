import Link from "next/link";
import { createWallet } from "../actions";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, inputClass, selectClass } from "@/components/ui/Field";

export default function NewWalletPage() {
  return (
    <>
      <p className="mb-2">
        <Link href="/wallets" className="text-sm text-fg-muted hover:text-fg">
          ← Wallets
        </Link>
      </p>

      <PageHeader title="Add wallet" />

      <Panel className="max-w-lg">
        <form action={createWallet} className="flex flex-col gap-4">
          <Field label="Name">
            <input name="name" type="text" required className={inputClass} />
          </Field>

          <Field label="Chain">
            <select name="chain" required defaultValue="" className={selectClass}>
              <option value="" disabled>
                Select a chain
              </option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="SOL">SOL</option>
            </select>
          </Field>

          <Field label="Mode">
            <select name="mode" required defaultValue="" className={selectClass}>
              <option value="" disabled>
                Select a mode
              </option>
              <option value="manual">manual — enter holdings by hand</option>
              <option value="auto">auto — adapter fetches holdings</option>
            </select>
          </Field>

          <Field label="Account">
            <select name="account" defaultValue="personal" className={selectClass}>
              <option value="personal">personal</option>
              <option value="biz">biz</option>
            </select>
          </Field>

          <Field label="Address" hint="Optional for manual">
            <input name="address" type="text" className={inputClass} />
          </Field>

          <Button type="submit" className="self-start">
            Create wallet
          </Button>
        </form>
      </Panel>
    </>
  );
}

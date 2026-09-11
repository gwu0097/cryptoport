import Link from "next/link";
import { createWallet } from "../actions";
import { getTags } from "@/lib/queries";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field, inputClass } from "@/components/ui/Field";
import { ChainModeFields } from "@/components/ChainModeFields";
import { ConnectAndLinkWallet } from "@/components/auth/ConnectAndLinkWallet";

// Reads the live tags list — must never be frozen into a static build
// artifact, same reasoning as the wallets list page.
export const dynamic = "force-dynamic";

export default async function NewWalletPage() {
  const tags = await getTags();

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

          <ChainModeFields />

          <Field label="Tag" hint="Optional — type an existing tag to reuse it, or a new name to create one.">
            <input name="tag" type="text" list="tags-datalist" className={inputClass} />
            <datalist id="tags-datalist">
              {tags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Address"
            hint="Optional for manual. For auto BTC: an xpub/ypub/zpub scans the whole HD wallet account, not just one address — use that instead of a single receive address unless you're sure that one address is where funds actually sit."
          >
            <input name="address" type="text" className={inputClass} />
          </Field>

          <SubmitButton className="self-start">Create wallet</SubmitButton>
        </form>

        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-fg-muted">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <p className="mb-2 text-xs text-fg-muted">
          Connect a wallet to verify you own it and add it in one step — you can rename it afterwards.
        </p>
        <ConnectAndLinkWallet />
      </Panel>
    </>
  );
}

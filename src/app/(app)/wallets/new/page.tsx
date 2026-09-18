import Link from "next/link";
import { createWallet } from "../actions";
import { getTags } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field, inputClass } from "@/components/ui/Field";
import { ChainModeFields } from "@/components/ChainModeFields";
import { ConnectWalletModal } from "@/components/auth/ConnectWalletModal";
import { ConnectCoinbaseModal } from "@/components/ConnectCoinbaseModal";
import { EXCHANGE_PROVIDERS } from "@/lib/exchangeProviders";
import { SignInPrompt } from "@/components/SignInPrompt";

// Reads the live tags list — must never be frozen into a static build
// artifact, same reasoning as the wallets list page.
export const dynamic = "force-dynamic";

export default async function NewWalletPage() {
  const [tags, user] = await Promise.all([getTags(), getUser()]);

  return (
    <>
      <p className="mb-2">
        <Link href="/wallets" className="text-sm text-fg-muted hover:text-fg">
          ← Wallets
        </Link>
      </p>

      <PageHeader title="Add wallet" />

      {!user ? (
        <SignInPrompt message="Sign up or log in to add a wallet." />
      ) : (
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

          <ConnectWalletModal />

          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-fg-muted">or connect an exchange</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* One modal component per provider id — EXCHANGE_PROVIDERS is
              the extensible list, this is the (currently one-entry) map
              from provider id to its own connect UI. Adding the next
              exchange means a new adapter + a new case here, not a rewrite
              of this page. */}
          <div className="flex flex-col gap-2">
            {EXCHANGE_PROVIDERS.map((provider) =>
              provider.id === "coinbase" ? <ConnectCoinbaseModal key={provider.id} provider={provider} /> : null,
            )}
          </div>
        </Panel>
      )}
    </>
  );
}

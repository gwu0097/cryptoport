import Link from "next/link";
import { createWallet } from "../actions";
import { getTags } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field, inputClass } from "@/components/ui/Field";
import { ChainModeAddressFields } from "@/components/ChainModeAddressFields";
import { TagPicker } from "@/components/TagPicker";
import { ConnectWalletModal } from "@/components/auth/ConnectWalletModal";
import { ConnectExchangeModal } from "@/components/ConnectExchangeModal";
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

            <ChainModeAddressFields />

            <Field label="Tags" hint="Optional — pick existing tags or type a new name to create one.">
              <TagPicker allTags={tags.map((t) => t.name)} />
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

          {/* EXCHANGE_PROVIDERS is the extensible list; ConnectExchangeModal
              is fully generic (dispatches to EXCHANGE_ADAPTERS by provider
              id) — adding the next exchange means a new adapter file + one
              registry line, not a rewrite of this page. */}
          <div className="flex flex-col gap-2">
            {EXCHANGE_PROVIDERS.map((provider) => (
              <ConnectExchangeModal key={provider.id} provider={provider} />
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

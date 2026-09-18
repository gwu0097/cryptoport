"use client";

import { useRef, useActionState } from "react";
import { connectCoinbase, type ConnectExchangeFormState } from "@/app/(app)/wallets/actions";
import type { ExchangeProvider } from "@/lib/exchangeProviders";
import { Field, inputClass } from "./ui/Field";
import { SubmitButton } from "./ui/SubmitButton";
import { Dialog } from "./ui/Dialog";
import { buttonClass } from "./ui/Button";

/**
 * The key is tested with a real live Coinbase call before anything is
 * saved (see connectCoinbase's own doc comment) — useActionState, not a
 * plain form action, specifically so a bad key's real error shows inline
 * in this dialog instead of crashing to Next's error boundary. Unlike
 * EditWalletModal, this deliberately does NOT close-on-submit: a failed
 * connect needs the dialog to stay open with the error visible; a
 * successful one navigates away via connectCoinbase's own redirect(),
 * which unmounts this anyway.
 */
export function ConnectCoinbaseModal({ provider }: { provider: ExchangeProvider }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, action] = useActionState<ConnectExchangeFormState, FormData>(connectCoinbase, undefined);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className={`${buttonClass("secondary", "md")} w-full justify-start gap-2`}
      >
        Connect {provider.name}
      </button>

      <Dialog ref={dialogRef} title={`Connect ${provider.name}`}>
        <form action={action} className="flex flex-col gap-4">
          {state?.error && (
            <p className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
              {state.error}
            </p>
          )}

          <ol className="list-decimal space-y-1 pl-4 text-xs text-fg-muted">
            {provider.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <a
            href={provider.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:underline"
          >
            Open {provider.name}&rsquo;s API key page →
          </a>

          <Field label="Name" hint="What to call this wallet in your list.">
            <input name="name" type="text" required defaultValue={provider.name} className={inputClass} />
          </Field>

          <Field label="Key name" hint="organizations/.../apiKeys/...">
            <input name="keyName" type="text" required className={inputClass} />
          </Field>

          <Field label="Private key" hint="The PEM block, exactly as shown — including the BEGIN/END lines.">
            <textarea
              name="privateKey"
              required
              rows={6}
              className={`${inputClass} font-mono text-xs`}
              spellCheck={false}
            />
          </Field>

          <p className="text-xs text-fg-muted">
            Stored encrypted, only ever used server-side to read balances — never trading/withdrawal capable if you
            picked View-only permission above.
          </p>

          <SubmitButton pendingLabel="Connecting…" className="self-start">
            Connect {provider.name}
          </SubmitButton>
        </form>
      </Dialog>
    </>
  );
}

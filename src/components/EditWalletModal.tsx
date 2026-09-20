"use client";

import { useRef } from "react";
import { Pencil } from "lucide-react";
import { Field, inputClass } from "./ui/Field";
import { SubmitButton } from "./ui/SubmitButton";
import { Dialog } from "./ui/Dialog";
import { ChainModeAddressFields } from "./ChainModeAddressFields";
import { TagPicker } from "./TagPicker";
import type { WalletWithTags } from "@/lib/types";

/**
 * Edit-wallet form as a popup instead of always-visible page content —
 * reused on both the wallets list (one per row) and the wallet detail page
 * (next to the name). Native <dialog> (see ui/Dialog.tsx) rather than a
 * hand-rolled overlay: built-in top-layer rendering (no z-index fights),
 * Escape-to-close, and a focus trap, all for free. Client-only for the
 * open/close calls (showModal()/close() are imperative DOM methods, no
 * declarative HTML equivalent yet has broad enough support to rely on) —
 * the form submission itself is still a plain server action.
 */
export function EditWalletModal({
  wallet,
  tagNames,
  updateWallet,
}: {
  wallet: WalletWithTags;
  tagNames: string[];
  updateWallet: (formData: FormData) => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        aria-label={`Edit ${wallet.name}`}
        onClick={() => dialogRef.current?.showModal()}
        className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-muted transition hover:bg-surface-raised hover:text-fg"
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>

      <Dialog ref={dialogRef} title="Edit wallet">
        <form
          action={updateWallet}
          onSubmit={() => dialogRef.current?.close()}
          className="flex flex-col gap-4"
        >
          <Field label="Name">
            <input name="name" type="text" required defaultValue={wallet.name} className={inputClass} />
          </Field>

          {/* A connected exchange (Coinbase/Kraken/Gemini) has no real
              chain/mode/address to edit — `chain` is just a display label
              ("COINBASE"), not a real chain this app's sync adapters
              recognize, and `address` doesn't apply at all (it
              authenticates via exchange_connections instead). Rendering
              these fields for one anyway used to submit "COINBASE" as the
              chain on save, which updateWallet's own validation correctly
              rejects as an unsupported auto-mode chain — a real crash,
              reported directly, editing a Coinbase wallet's tags. Omitting
              the fields (rather than just hiding them) means the form
              never submits chain/mode at all for these, which is also
              what tells updateWallet not to touch them. */}
          {!wallet.provider && (
            <ChainModeAddressFields
              defaultChain={wallet.chain}
              defaultMode={wallet.mode}
              defaultAddress={wallet.address ?? ""}
            />
          )}

          <Field label="Tags" hint="Optional — pick existing tags or type a new name to create one.">
            <TagPicker allTags={tagNames} defaultSelected={wallet.tags.map((t) => t.name)} />
          </Field>

          <SubmitButton className="self-start">Save changes</SubmitButton>
        </form>
      </Dialog>
    </>
  );
}

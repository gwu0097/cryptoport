"use client";

import { useRef } from "react";
import { Pencil, X } from "lucide-react";
import { Field, inputClass, selectClass } from "./ui/Field";
import { SubmitButton } from "./ui/SubmitButton";
import type { WalletWithTag } from "@/lib/types";

/**
 * Edit-wallet form as a popup instead of always-visible page content —
 * reused on both the wallets list (one per row) and the wallet detail page
 * (next to the name). Native <dialog> rather than a hand-rolled overlay:
 * built-in top-layer rendering (no z-index fights), Escape-to-close, and
 * a focus trap, all for free. Client-only for the open/close calls
 * (showModal()/close() are imperative DOM methods, no declarative HTML
 * equivalent yet has broad enough support to rely on) — the form
 * submission itself is still a plain server action.
 */
export function EditWalletModal({
  wallet,
  tagNames,
  updateWallet,
}: {
  wallet: WalletWithTag;
  tagNames: string[];
  updateWallet: (formData: FormData) => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const datalistId = `tags-${wallet.id}`;

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

      <dialog
        ref={dialogRef}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
        className="w-full max-w-lg rounded-xl border border-border bg-surface p-0 text-fg backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-fg">Edit wallet</h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="text-fg-muted hover:text-fg"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <form
          action={updateWallet}
          onSubmit={() => dialogRef.current?.close()}
          className="flex flex-col gap-4 p-5"
        >
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

          <Field label="Tag" hint="Optional — type an existing tag to reuse it, or a new name to create one.">
            <input
              name="tag"
              type="text"
              list={datalistId}
              defaultValue={wallet.tag?.name ?? ""}
              className={inputClass}
            />
            <datalist id={datalistId}>
              {tagNames.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Address"
            hint="For auto BTC: an xpub/ypub/zpub scans the whole HD wallet account, not just one address."
          >
            <input name="address" type="text" defaultValue={wallet.address ?? ""} className={inputClass} />
          </Field>

          <SubmitButton className="self-start">Save changes</SubmitButton>
        </form>
      </dialog>
    </>
  );
}

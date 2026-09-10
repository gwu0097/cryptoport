"use client";

import { useRef } from "react";
import { Plus } from "lucide-react";
import { Field, inputClass } from "./ui/Field";
import { SubmitButton } from "./ui/SubmitButton";
import { buttonClass } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

/**
 * "+ Add holding" as a popup (see ui/Dialog.tsx) rather than two
 * always-visible panels at the bottom of the wallet page — keeps the page
 * itself to just the wallet's actual holdings. Both entry modes (by
 * quantity, priced live off the shared ticker table; by a fixed USD value,
 * bypassing pricing entirely) live in the same popup rather than two
 * separate buttons, matching how they were already presented side by side.
 */
export function AddHoldingModal({
  addHolding,
  defaultTicker,
}: {
  addHolding: (formData: FormData) => void | Promise<void>;
  defaultTicker?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className={buttonClass("secondary", "sm")}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add holding
      </button>

      <Dialog ref={dialogRef} title="Add holding">
        <div className="grid gap-4 sm:grid-cols-2">
          <form
            action={addHolding}
            onSubmit={() => dialogRef.current?.close()}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="kind" value="qty" />
            <Field label="Ticker">
              <input name="ticker" type="text" required defaultValue={defaultTicker} className={inputClass} />
            </Field>
            <Field label="Quantity">
              <input name="qty" type="text" inputMode="decimal" required className={inputClass} />
            </Field>
            <SubmitButton className="self-start">Add by quantity</SubmitButton>
          </form>

          <form
            action={addHolding}
            onSubmit={() => dialogRef.current?.close()}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="kind" value="usd" />
            <Field label="Ticker">
              <input name="ticker" type="text" required className={inputClass} />
            </Field>
            <Field label="Fixed USD value">
              <input name="usd_override" type="text" inputMode="decimal" required className={inputClass} />
            </Field>
            <SubmitButton className="self-start">Add fixed USD value</SubmitButton>
          </form>
        </div>
      </Dialog>
    </>
  );
}

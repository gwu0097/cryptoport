"use client";

import type { ReactNode } from "react";
import { Button, type ButtonProps } from "../ui/Button";

/**
 * The button half of useJob() — disabled and showing a label for the
 * entire real duration of the background job (not just the brief network
 * round-trip to kick it off, which is what SubmitButton/useFormStatus can
 * only ever cover). `busy`/`isPending`/`submit` come straight from
 * useJob(); this component owns no state of its own.
 */
export function JobButton({
  busy,
  isPending,
  submit,
  pendingLabel = "Starting…",
  busyLabel,
  children,
  ...props
}: {
  busy: boolean;
  isPending: boolean;
  submit: () => void;
  pendingLabel?: ReactNode;
  busyLabel: ReactNode;
} & Omit<ButtonProps, "onClick" | "disabled" | "type">) {
  return (
    <Button type="button" onClick={submit} disabled={busy} {...props}>
      {isPending ? pendingLabel : busy ? busyLabel : children}
    </Button>
  );
}

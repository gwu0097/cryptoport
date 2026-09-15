"use client";

import type { ReactNode } from "react";
import { Button, type ButtonProps } from "../ui/Button";

/**
 * The button half of useJob() — disabled and showing a label for the
 * entire real duration of the background job (not just the brief network
 * round-trip to kick it off, which is what SubmitButton/useFormStatus can
 * only ever cover). `busy`/`submit` come straight from useJob(); this
 * component owns no state of its own.
 *
 * One `busyLabel` covers the whole busy window — the in-flight click and
 * the confirmed-running background job both just render as "busy, locked,
 * doing the thing." An earlier version showed a separate "Starting…"
 * label for the in-flight-click sub-phase; reported directly as pointless
 * ("why even have starting at all") — a real distinction to the code
 * (isPending vs. status.running) but not one the user asked to see, and
 * once the click round-trip got fast (parallelized claims), it read as an
 * unexplained flicker between two phrases rather than useful information.
 * `isPending` is accepted for callers that still want to branch on it for
 * something other than the label; JobButton itself no longer does.
 */
export function JobButton({
  busy,
  submit,
  busyLabel,
  children,
  ...props
}: {
  busy: boolean;
  isPending?: boolean;
  submit: () => void;
  busyLabel: ReactNode;
} & Omit<ButtonProps, "onClick" | "disabled" | "type">) {
  return (
    <Button type="button" onClick={submit} disabled={busy} {...props}>
      {busy ? busyLabel : children}
    </Button>
  );
}

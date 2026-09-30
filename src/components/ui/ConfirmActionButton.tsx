"use client";

import { useState, type ReactNode } from "react";
import { Button } from "./Button";

/**
 * A destructive button that asks first, in the page: a click shows the
 * question with "Yes" and "Cancel" in its place. Not window.confirm() — an
 * app's built-in browser (a link opened from Discord or Instagram) can
 * block that dialog, and the button then silently did nothing (owner
 * 2026-09-30, Stop watching on a phone).
 *
 * `onConfirm` for a client action; or `submit` for a form's submit button
 * (the "Yes" submits the enclosing form).
 */
export function ConfirmActionButton({
  message,
  confirmLabel = "Yes",
  onConfirm,
  submit = false,
  disabled = false,
  trigger,
  size = "sm",
}: {
  /** The question, shown while confirming ("Stop watching Risk?"). */
  message: string;
  confirmLabel?: string;
  onConfirm?: () => void;
  submit?: boolean;
  disabled?: boolean;
  /** The first-click control (a Button or an icon button's content). */
  trigger: (open: () => void) => ReactNode;
  size?: "sm" | "md";
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <>{trigger(() => setAsking(true))}</>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={message}>
      <span className="text-xs text-fg-muted">{message}</span>
      <Button
        type={submit ? "submit" : "button"}
        variant="danger"
        size={size}
        disabled={disabled}
        onClick={() => {
          if (!submit) setAsking(false);
          onConfirm?.();
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="secondary" size={size} onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}

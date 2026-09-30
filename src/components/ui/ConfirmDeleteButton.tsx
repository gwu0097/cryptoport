"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";
import { ConfirmActionButton } from "./ConfirmActionButton";

// Wraps a delete form's submit button: asks in the page before submitting
// (ConfirmActionButton — not window.confirm, which an app's built-in
// browser can block), and disables itself while the request is in flight
// so a slow response can't be mistaken for "nothing happened".
export function ConfirmDeleteButton({
  confirmMessage,
  children,
  ...props
}: { confirmMessage: string } & Omit<ButtonProps, "type" | "variant" | "size" | "disabled" | "onClick">) {
  const { pending } = useFormStatus();

  return (
    <ConfirmActionButton
      message={confirmMessage}
      confirmLabel="Yes, delete"
      submit
      disabled={pending}
      trigger={(open) => (
        <Button type="button" variant="danger" size="sm" disabled={pending} onClick={open} {...props}>
          {children}
        </Button>
      )}
    />
  );
}

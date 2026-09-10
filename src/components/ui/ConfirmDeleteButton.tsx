"use client";

import type { MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

// Wraps a delete form's submit button: confirms before submitting, and
// disables itself while the request is in flight so a slow response can't
// be mistaken for "nothing happened" and clicked again.
export function ConfirmDeleteButton({
  confirmMessage,
  onClick,
  ...props
}: { confirmMessage: string } & Omit<ButtonProps, "type" | "variant" | "size" | "disabled">) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="danger"
      size="sm"
      disabled={pending}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (!confirm(confirmMessage)) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...props}
    />
  );
}

"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

// Disables itself while the form is submitting — without this, clicking
// twice (or once impatiently on a slow connection) fires the server action
// twice, e.g. creating the same wallet more than once.
export function SubmitButton({ children, ...props }: Omit<ButtonProps, "type" | "disabled">) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? "Saving…" : children}
    </Button>
  );
}

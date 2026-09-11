"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, type AuthFormState } from "../actions";
import { Panel } from "@/components/ui/Panel";
import { Field, inputClass } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";

export default function ForgotPasswordPage() {
  const [state, action] = useActionState<AuthFormState, FormData>(requestPasswordReset, undefined);

  return (
    <Panel title="Reset your password">
      {state?.success ? (
        <p className="rounded-lg border border-positive/30 bg-positive/10 px-4 py-3 text-sm text-positive">
          {state.success}
        </p>
      ) : (
        <form action={action} className="flex flex-col gap-4">
          {state?.error && (
            <p className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
              {state.error}
            </p>
          )}

          <Field label="Email" hint="We'll send a link to reset your password.">
            <input name="email" type="email" required autoComplete="email" className={inputClass} />
          </Field>

          <p className="text-xs text-fg-muted">
            <Link href="/login" className="text-fg hover:text-accent">
              Back to log in
            </Link>
          </p>

          <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
        </form>
      )}
    </Panel>
  );
}

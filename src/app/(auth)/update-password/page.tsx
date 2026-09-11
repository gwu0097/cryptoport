"use client";

import { useActionState } from "react";
import { updatePassword, type AuthFormState } from "../actions";
import { Panel } from "@/components/ui/Panel";
import { Field, inputClass } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";

export default function UpdatePasswordPage() {
  const [state, action] = useActionState<AuthFormState, FormData>(updatePassword, undefined);

  return (
    <Panel title="Set a new password">
      <form action={action} className="flex flex-col gap-4">
        {state?.error && (
          <p className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
            {state.error}
          </p>
        )}

        <Field label="New password" hint="At least 8 characters.">
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputClass}
          />
        </Field>

        <Field label="Confirm new password">
          <input
            name="confirmPassword"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputClass}
          />
        </Field>

        <SubmitButton pendingLabel="Updating…">Update password</SubmitButton>
      </form>
    </Panel>
  );
}

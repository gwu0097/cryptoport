"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signUp, type AuthFormState } from "../actions";
import { Panel } from "@/components/ui/Panel";
import { Field, inputClass } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";

export default function SignupPage() {
  const [state, action] = useActionState<AuthFormState, FormData>(signUp, undefined);

  return (
    <Panel title="Create an account">
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

          <Field label="Email">
            <input name="email" type="email" required autoComplete="email" className={inputClass} />
          </Field>

          <Field label="Password" hint="At least 8 characters.">
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className={inputClass}
            />
          </Field>

          <Field label="Confirm password">
            <input
              name="confirmPassword"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className={inputClass}
            />
          </Field>

          <p className="text-xs text-fg-muted">
            Already have an account?{" "}
            <Link href="/login" className="text-fg hover:text-accent">
              Log in
            </Link>
          </p>

          <SubmitButton pendingLabel="Creating account…">Sign up</SubmitButton>
        </form>
      )}
    </Panel>
  );
}

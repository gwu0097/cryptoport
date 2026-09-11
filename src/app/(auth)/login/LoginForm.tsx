"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn, type AuthFormState } from "../actions";
import { Panel } from "@/components/ui/Panel";
import { Field, inputClass } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SignInWalletModal } from "@/components/auth/SignInWalletModal";

export function LoginForm({ initialError }: { initialError?: string }) {
  const [state, action] = useActionState<AuthFormState, FormData>(
    signIn,
    initialError ? { error: initialError } : undefined,
  );

  return (
    <Panel title="Log in">
      <form action={action} className="flex flex-col gap-4">
        {state?.error && (
          <p className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
            {state.error}
          </p>
        )}

        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" className={inputClass} />
        </Field>

        <Field label="Password">
          <input name="password" type="password" required autoComplete="current-password" className={inputClass} />
        </Field>

        <div className="flex items-center justify-between text-xs">
          <Link href="/forgot-password" className="text-fg-muted hover:text-fg">
            Forgot password?
          </Link>
          <Link href="/signup" className="text-fg-muted hover:text-fg">
            Create an account
          </Link>
        </div>

        <SubmitButton pendingLabel="Logging in…">Log in</SubmitButton>
      </form>

      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-fg-muted">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <SignInWalletModal />
    </Panel>
  );
}

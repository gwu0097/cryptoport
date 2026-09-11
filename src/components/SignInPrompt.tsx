import Link from "next/link";
import { LogIn } from "lucide-react";
import { Panel } from "./ui/Panel";
import { buttonClass } from "./ui/Button";

/** The guest-facing empty state for any page that normally shows account
 * data — same visual shape as ComingSoon.tsx (icon + centered message in a
 * Panel), with sign-up/log-in buttons instead of a "Coming soon" pill.
 * Every page is viewable without a session; this is what replaces the data
 * itself where there's nothing to show a guest. /login and /signup both
 * already have the WalletButton mode="signin" flow, so "connect a wallet
 * instead" is one click away from either — no separate button needed here. */
export function SignInPrompt({ message }: { message: string }) {
  return (
    <Panel className="grid min-h-64 place-items-center text-center">
      <div className="flex flex-col items-center gap-3">
        <LogIn className="size-10 text-fg-muted" aria-hidden="true" />
        <p className="max-w-sm text-sm text-fg-muted">{message}</p>
        <div className="flex gap-2">
          <Link href="/signup" className={buttonClass("primary", "sm")}>
            Sign up
          </Link>
          <Link href="/login" className={buttonClass("secondary", "sm")}>
            Log in
          </Link>
        </div>
      </div>
    </Panel>
  );
}

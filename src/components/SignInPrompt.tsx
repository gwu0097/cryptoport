import { LogIn } from "lucide-react";
import { Panel } from "./ui/Panel";
import { AuthButtons } from "./AuthButtons";

/** The guest-facing empty state for a page with genuinely nothing to
 * preview (wallets/new's form, settings' account-specific panels) — same
 * visual shape as ComingSoon.tsx (icon + centered message in a Panel).
 * Every other data page (Dashboard, Portfolio, Wallets, Assets, DeFi,
 * Analytics) instead renders its real layout for guests with one
 * GuestBanner (a compact version of this same sign-up/log-in pair) plus
 * honest "log in to see this" placeholders per section — see GuestBanner's
 * own doc comment and CLAUDE.md's UI conventions note. */
export function SignInPrompt({ message }: { message: string }) {
  return (
    <Panel className="grid min-h-64 place-items-center text-center">
      <div className="flex flex-col items-center gap-3">
        <LogIn className="size-10 text-fg-muted" aria-hidden="true" />
        <p className="max-w-sm text-sm text-fg-muted">{message}</p>
        <AuthButtons />
      </div>
    </Panel>
  );
}

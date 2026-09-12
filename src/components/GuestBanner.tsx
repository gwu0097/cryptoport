import { Panel } from "./ui/Panel";
import { AuthButtons } from "./AuthButtons";

/**
 * The ONE sign-up/log-in call to action on a data page's guest view —
 * sits where TotalValuePanel would render for a signed-in user, so the
 * page's shape stays the same either way. Everything below this still
 * renders its real Panels/titles for a guest (so the page shows what the
 * product actually looks like, not a wall replaced by one big empty
 * state), just with a muted "log in to see this" line instead of real
 * data and no button of its own — one CTA per page, not one per section.
 * Never fabricated numbers in those placeholders: a mocked-up total/table
 * would be exactly the "plausible-looking wrong number" CLAUDE.md's Data
 * Correctness rule exists to prevent, guest or not.
 */
export function GuestBanner({ message }: { message: string }) {
  return (
    <Panel className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-fg-muted">{message}</p>
      <AuthButtons />
    </Panel>
  );
}

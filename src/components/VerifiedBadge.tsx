import { ShieldCheck } from "lucide-react";

/**
 * Shown in place of VerifyWalletModal's trigger once a wallet's address is
 * verified (see WalletWithTotal.verified) — same two spots that trigger
 * lives (wallet detail page's header, WalletsTable's Chain cell), same
 * "icon" vs "button" sizing split, so a verified wallet looks like the same
 * affordance just resolved rather than a different UI entirely.
 */
export function VerifiedBadge({ variant = "button" }: { variant?: "button" | "icon" }) {
  if (variant === "icon") {
    return (
      <span
        className="grid size-7 shrink-0 place-items-center text-positive"
        title="Verified — you can sign in with this wallet."
        aria-label="Verified"
      >
        <ShieldCheck className="size-4" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-lg bg-positive/10 px-2.5 py-1.5 text-xs font-medium text-positive"
      title="You can sign in with this wallet."
    >
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      Verified
    </span>
  );
}

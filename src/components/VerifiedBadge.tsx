import { ShieldCheck } from "lucide-react";

/**
 * Shown in place of VerifyWalletModal's trigger once a wallet's address is
 * verified (see WalletWithTotal.verified) — same two spots that trigger
 * lives (wallet detail page's header, WalletsTable's Chain cell). Always
 * labeled "Verified", never a bare shield icon — an icon-only badge is
 * indistinguishable from the icon-only Verify trigger it replaces at a
 * glance, so neither read as meaningful without text.
 */
export function VerifiedBadge() {
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

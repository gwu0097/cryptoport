import Link from "next/link";
import { buttonClass } from "./ui/Button";

/** The Sign up / Log in pair — pulled out once both SignInPrompt (the
 * full-block guest empty-state, still used where there's genuinely
 * nothing to preview: wallets/new, settings) and GuestBanner (the compact
 * single-CTA banner used on pages that render their real shell to guests)
 * needed the identical two links. /login and /signup both already have
 * the WalletButton mode="signin" flow, so "connect a wallet instead" is
 * one click away from either — no separate button needed here. */
export function AuthButtons({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <div className="flex gap-2">
      <Link href="/signup" className={buttonClass("primary", size)}>
        Sign up
      </Link>
      <Link href="/login" className={buttonClass("secondary", size)}>
        Log in
      </Link>
    </div>
  );
}

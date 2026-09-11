import type { ReactNode } from "react";
import Link from "next/link";

// Deliberately no AppShell here — a plain centered card, no sidebar/top-bar
// chrome meant for someone who's already signed in. Every real page is
// browsable without an account now (see (app)/layout.tsx), but /lookup is
// still a distinct, narrower feature (raw address search, no saved
// wallets/tags at all — see lookup/layout.tsx) worth surfacing directly
// from the one place a signed-out visitor is guaranteed to land.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-12 text-fg">
      <p className="mb-8 text-lg font-semibold tracking-tight">
        Crypto<span className="text-accent">Port</span>
      </p>
      <div className="w-full max-w-sm">{children}</div>
      <Link href="/lookup" className="mt-6 text-xs text-fg-muted hover:text-fg">
        Just want to look up an address? No account needed →
      </Link>
    </div>
  );
}

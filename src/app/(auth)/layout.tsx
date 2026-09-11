import type { ReactNode } from "react";
import Link from "next/link";

// Deliberately no AppShell here (see the root layout's own comment) — a
// plain centered card, no sidebar/top-bar chrome meant for someone who's
// already signed in. The /lookup link below is what makes the public
// address-search feature actually discoverable — it's reachable without an
// account (see lookup/layout.tsx), but nothing on this page said so before,
// so a signed-out visitor landing here had no way to find it short of
// already knowing the URL.
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

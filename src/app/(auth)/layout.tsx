import type { ReactNode } from "react";

// Deliberately no AppShell here (see the root layout's own comment) — a
// plain centered card, no sidebar/top-bar chrome meant for someone who's
// already signed in. Not a link to "/" — for a signed-out visitor that
// would just bounce through the (app) redirect chain back to /login.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-12 text-fg">
      <p className="mb-8 text-lg font-semibold tracking-tight">
        Crypto<span className="text-accent">Port</span>
      </p>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

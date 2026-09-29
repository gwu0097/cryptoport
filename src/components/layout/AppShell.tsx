import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";

export function AppShell({
  children,
  userEmail,
  isAdmin,
}: {
  children: ReactNode;
  userEmail: string | null;
  isAdmin: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <TopBar userEmail={userEmail} isAdmin={isAdmin} />
      <div className="flex flex-1">
        <Sidebar isAdmin={isAdmin} />
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 2xl:px-10">
          {/* Widths (industry convention: fluid up to a cap): table pages
              fill up to 1600px; a page marking itself data-page-width="full"
              (the Dashboard — more columns on wide screens, not margins)
              has no cap; "reading" pages (settings, profile, the
              encyclopedia) keep a narrower measure. */}
          <div className="mx-auto w-full max-w-[1600px] has-[[data-page-width=full]]:max-w-none has-[[data-page-width=reading]]:max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}

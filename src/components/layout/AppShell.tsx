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
        <main className="min-w-0 flex-1 px-6 py-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}

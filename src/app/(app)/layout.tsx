import { AppShell } from "@/components/layout/AppShell";
import { requireUser } from "@/lib/auth";

// Every real page of the app lives under this route group (invisible in
// the URL — /wallets is still /wallets) so it can share one layout that
// (a) wraps everything in the sidebar/top-bar chrome and (b) enforces a
// session before rendering anything below it. proxy.ts already redirects
// an unauthenticated request before it gets here — this is the second,
// data-layer line of defense the plan calls for, not the only one.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <AppShell userEmail={user.email ?? null}>{children}</AppShell>;
}

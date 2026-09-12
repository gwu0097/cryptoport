import { AppShell } from "@/components/layout/AppShell";
import { getUser } from "@/lib/auth";
import { walletDisplayName } from "@/lib/walletDisplay";

// Every real page of the app lives under this route group (invisible in
// the URL — /wallets is still /wallets) so it can share one layout for the
// sidebar/top-bar chrome. Deliberately getUser() (nullable), not
// requireUser() — every page here is viewable without a session (see
// db/schema.sql's linked_wallets comment and queries.ts's per-function
// guest guards); only saving anything requires an account, enforced by
// requireUser() inside each Server Action plus RLS underneath it, not by
// gating pages. Same pattern lookup/layout.tsx already used.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  // A wallet-only account's real "email" is a meaningless synthetic UUID
  // (see walletDisplay.ts) — show its linked address instead wherever this
  // reaches TopBar.
  return (
    <AppShell userEmail={(user && walletDisplayName(user)) ?? user?.email ?? null}>{children}</AppShell>
  );
}

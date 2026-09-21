import { AppShell } from "@/components/layout/AppShell";
import { JobPollerProvider } from "@/components/jobs/JobPoller";
import { HideBalanceProvider } from "@/components/HideBalanceProvider";
import { getUser } from "@/lib/auth";
import { walletDisplayName } from "@/lib/walletDisplay";
import { isAdminEmail } from "@/lib/adminEmail";

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
  // isAdminEmail (adminEmail.ts, not adminAuth.ts) — the pure comparison
  // only, computed here server-side so the actual ADMIN_EMAIL value never
  // reaches AppShell's client-component tree, just this derived boolean.
  // This only controls nav-link *visibility* — src/lib/adminAuth.ts's
  // requireAdmin() on the /admin routes themselves is what actually
  // enforces access.
  const isAdmin = isAdminEmail(user?.email, process.env.ADMIN_EMAIL);
  return (
    <JobPollerProvider>
      <HideBalanceProvider>
        <AppShell userEmail={(user && walletDisplayName(user)) ?? user?.email ?? null} isAdmin={isAdmin}>
          {children}
        </AppShell>
      </HideBalanceProvider>
    </JobPollerProvider>
  );
}

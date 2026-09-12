import { AppShell } from "@/components/layout/AppShell";
import { getUser } from "@/lib/auth";
import { walletDisplayName } from "@/lib/walletDisplay";

// Deliberately its own top-level route, not under (app) — the address
// lookup is read-only and saves nothing (see lookup/page.tsx's own
// subtitle), so it's the one page a signed-out visitor can use, same as
// DeBank/Rabby let you look up any address without connecting a wallet.
// getUser() (nullable), not requireUser() — AppShell already renders fine
// with userEmail: null (see TopBar), no redirect here.
export default async function LookupLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  return <AppShell userEmail={(user && walletDisplayName(user)) ?? user?.email ?? null}>{children}</AppShell>;
}

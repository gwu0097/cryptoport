import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/adminAuth";
import { PageHeader } from "@/components/PageHeader";
import { OwnerConsoleTabs } from "@/components/admin/OwnerConsoleTabs";

/** Owner's console: one header and a tab per feature (Users, API list,
 * Pricing coverage). Every page under it still calls requireAdmin() itself;
 * this one keeps the header from rendering for anyone else. */
export default async function OwnerConsoleLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return (
    <>
      <PageHeader title="Owner's console" />
      <OwnerConsoleTabs />
      {children}
    </>
  );
}

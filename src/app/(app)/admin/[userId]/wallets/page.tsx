import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/adminAuth";
import { getAdminTargetUser } from "@/lib/adminQueries";
import { getWalletsWithTotals } from "@/lib/queries";
import { AdminUserBanner } from "@/components/admin/AdminUserBanner";
import { AdminWalletsTable } from "@/components/admin/AdminWalletsTable";
import { Panel } from "@/components/ui/Panel";

export const dynamic = "force-dynamic";

/** Read-only Wallets peek for one user — see AdminWalletsTable's own doc
 * comment for why this isn't the real WalletsTable with a flag. */
export default async function AdminUserWalletsPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireAdmin();
  const { userId } = await params;

  const target = await getAdminTargetUser(userId);
  if (!target) notFound();

  const { wallets } = await getWalletsWithTotals({ userId });

  return (
    <>
      <AdminUserBanner userId={userId} displayName={target.displayName} active="/wallets" />

      {wallets.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">No wallets.</p>
        </Panel>
      ) : (
        <Panel padding={false} className="overflow-hidden">
          <AdminWalletsTable wallets={wallets} />
        </Panel>
      )}
    </>
  );
}

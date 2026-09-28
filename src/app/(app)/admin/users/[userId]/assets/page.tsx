import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/adminAuth";
import { getAdminTargetUser } from "@/lib/adminQueries";
import { getAssetsGroupedByTicker } from "@/lib/queries";
import { AdminUserBanner } from "@/components/admin/AdminUserBanner";
import { AssetsTable } from "@/components/AssetsTable";
import { Panel } from "@/components/ui/Panel";

export const dynamic = "force-dynamic";

/** Read-only Assets peek for one user. AssetsTable itself has no mutation
 * actions (confirmed before reusing it directly — see its own imports),
 * so unlike WalletsTable it's safe to reuse as-is here, no separate
 * read-only component needed. */
export default async function AdminUserAssetsPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireAdmin();
  const { userId } = await params;

  const target = await getAdminTargetUser(userId);
  if (!target) notFound();

  const { groups, grand } = await getAssetsGroupedByTicker({ userId });

  return (
    <>
      <AdminUserBanner userId={userId} displayName={target.displayName} active="/assets" />

      {groups.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">No holdings.</p>
        </Panel>
      ) : (
        <AssetsTable groups={groups} total={grand.total} />
      )}
    </>
  );
}

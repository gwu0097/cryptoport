import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/adminAuth";
import { getAdminTargetUser } from "@/lib/adminQueries";
import { getWalletDetail } from "@/lib/queries";
import { AdminUserBanner } from "@/components/admin/AdminUserBanner";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { HoldingsTable } from "@/components/HoldingsTable";
import { TruncatedAddress } from "@/components/TruncatedAddress";
import { formatStaleness } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Read-only drill-down into one of the target user's wallets — reported
 * directly: "I can peek at the wallets but I can't go into them," raised
 * alongside "dj says the gemini kinda worked but not really and I can't
 * see what he's seeing." AdminWalletsTable's rows had nowhere to link to
 * (no admin wallet-detail route existed at all); this is that route.
 *
 * Deliberately the same "separate, minimal component, not the real page
 * with a flag" call as AdminWalletsTable — reuses ChainGroupedHoldings/
 * HoldingsTable/TotalValuePanel as pure, already-read-only-when-unwired
 * presentational pieces (walletId/actions are optional there specifically
 * so a caller with nothing to mutate can omit them), but imports zero
 * Server Actions of its own — Edit/Verify/Sync/Delete/AddHolding all stay
 * exclusive to the real /wallets/[id] page a user reaches under their own
 * session.
 *
 * The sync-status panel below is the actual point of this page for the
 * "can't see what he's seeing" case: `last_refresh_status`/
 * `exchange_sync_status` carry the literal error/partial-failure string a
 * sync wrote (e.g. a Gemini connection that's "partial" for a specific,
 * diagnosable reason) — the same text the user themselves would see on
 * their own wallet page, now visible to an admin without needing them to
 * screenshot it.
 */
export default async function AdminWalletDetailPage({
  params,
}: {
  params: Promise<{ userId: string; walletId: string }>;
}) {
  await requireAdmin();
  const { userId, walletId } = await params;

  const target = await getAdminTargetUser(userId);
  if (!target) notFound();

  const detail = await getWalletDetail(walletId, { userId });
  if (!detail) notFound();

  const { wallet, holdings, chainGroups, total, unpricedCount } = detail;

  return (
    <>
      <AdminUserBanner userId={userId} displayName={target.displayName} active="/wallets" />

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-fg">{wallet.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1 text-sm text-fg-muted">
          <span>{wallet.chain}</span>
          {wallet.tags.length > 0 && (
            <>
              <span>·</span>
              <span>{wallet.tags.map((t) => t.name).join(", ")}</span>
            </>
          )}
          <span>·</span>
          <span>{wallet.mode}</span>
          {wallet.provider && (
            <>
              <span>·</span>
              <span>{wallet.provider}</span>
            </>
          )}
          {wallet.address && (
            <>
              <span>·</span>
              <TruncatedAddress address={wallet.address} />
            </>
          )}
        </p>
      </div>

      {/* Raw status text, not a hover tooltip (unlike the real wallet page's
          TriangleAlert icon) — the whole point here is making a sync
          problem visible to an admin without asking the user to describe
          or screenshot it themselves. */}
      {(wallet.last_refresh_status || wallet.exchange_sync_status) && (
        <Panel className="mb-6" title="Sync status">
          {wallet.provider ? (
            <>
              <p className="text-sm text-fg">
                {wallet.exchange_sync_status ?? "never synced"}
                {wallet.exchange_synced_at && (
                  <span className="text-fg-muted"> · last synced {formatStaleness(wallet.exchange_synced_at)}</span>
                )}
              </p>
            </>
          ) : (
            <p className="text-sm text-fg">
              {wallet.last_refresh_status ?? "never synced"}
              {wallet.last_refresh_at && (
                <span className="text-fg-muted"> · last synced {formatStaleness(wallet.last_refresh_at)}</span>
              )}
            </p>
          )}
        </Panel>
      )}

      <TotalValuePanel total={total}>
        {unpricedCount > 0 && (
          <p className="mt-2 text-sm text-warning">
            {unpricedCount} holding{unpricedCount === 1 ? "" : "s"} unpriced and excluded from the total
          </p>
        )}
        {wallet.notes && <p className="mt-2 text-sm text-fg-muted">{wallet.notes}</p>}
      </TotalValuePanel>

      {wallet.mode === "auto" ? (
        <div className="mb-6">
          <ChainGroupedHoldings
            groups={chainGroups}
            grandTotal={total}
            hideUnpriced={false}
            hideLow={false}
            baseHref={`/admin/${userId}/wallets/${walletId}`}
            emptyMessage="No holdings."
          />
        </div>
      ) : holdings.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">No holdings.</p>
        </Panel>
      ) : (
        <Panel padding={false} className="mb-6 overflow-hidden">
          <HoldingsTable holdings={holdings} />
        </Panel>
      )}
    </>
  );
}

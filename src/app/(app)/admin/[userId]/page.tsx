import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/adminAuth";
import { getAdminTargetUser } from "@/lib/adminQueries";
import { getAssetsGroupedByTicker, getValueHistory } from "@/lib/queries";
import { AdminUserBanner } from "@/components/admin/AdminUserBanner";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { ValueHistoryChart } from "@/components/dashboard/ValueHistoryChart";
import { MoverList, type MoverItem } from "@/components/dashboard/MoverList";

export const dynamic = "force-dynamic";

const LOW_VALUE_USD = 10;

// Same gainers/losers cut as the real dashboard's own topMovers (dashboard/
// page.tsx) — not duplicated logic worth extracting given it's one small
// filter/sort/slice used in exactly two places, not the kind of drift-prone
// real logic the "extract on the third copy" threshold is about.
function topMovers(items: MoverItem[]): { gainers: MoverItem[]; losers: MoverItem[] } {
  const eligible = items.filter((i) => i.change24h !== null);
  const gainers = eligible
    .filter((i) => (i.change24h as number) > 0)
    .sort((a, b) => (b.change24h as number) - (a.change24h as number))
    .slice(0, 5);
  const losers = eligible
    .filter((i) => (i.change24h as number) < 0)
    .sort((a, b) => (a.change24h as number) - (b.change24h as number))
    .slice(0, 5);
  return { gainers, losers };
}

/**
 * Read-only Dashboard peek for one user — see adminQueries.ts/queries.ts's
 * own opts.userId doc comments for how this stays a genuinely separate
 * read path from that user's own session. No "Refresh prices" action (no
 * mutation surface at all on this whole route tree, by construction), no
 * Watchlist movers (out of scope for this feature — a personal research
 * list isn't "their portfolio").
 */
export default async function AdminUserDashboardPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireAdmin();
  const { userId } = await params;

  const target = await getAdminTargetUser(userId);
  if (!target) notFound();

  const [{ groups, grand }, history] = await Promise.all([
    getAssetsGroupedByTicker({ userId }),
    getValueHistory(undefined, { userId }),
  ]);

  const holdingsMoversEligible = groups.filter((g) => g.total >= LOW_VALUE_USD);
  const { gainers, losers } = topMovers(
    holdingsMoversEligible.map((g) => ({
      key: g.tickerKey,
      ticker: g.ticker,
      iconUrl: g.iconUrl,
      price: g.price,
      change24h: g.change24h,
      coingeckoId: g.coingeckoId ?? undefined,
    })),
  );

  return (
    <>
      <AdminUserBanner userId={userId} displayName={target.displayName} active="" />

      <TotalValuePanel total={grand.total} />

      <div className="mb-4">
        <ValueHistoryChart points={history} />
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <MoverList title="Top gainers (24h) · Holdings" items={gainers} href={`/admin/${userId}/assets`} />
        <MoverList title="Top losers (24h) · Holdings" items={losers} href={`/admin/${userId}/assets`} />
      </div>
    </>
  );
}

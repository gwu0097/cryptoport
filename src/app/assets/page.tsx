import { getAssetsGroupedByChain } from "@/lib/queries";
import { formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets · CryptoPort" };

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; hideSmall?: string }>;
}) {
  const { chain: selectedChain, hideSmall } = await searchParams;
  const { groups, grand } = await getAssetsGroupedByChain();

  return (
    <>
      <PageHeader title="Assets" subtitle="Every holding across all your wallets, grouped by chain" />

      <Panel className="mb-6">
        <p className="text-sm text-fg-muted">Total value</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">{formatUsd(grand.total)}</p>
        {grand.unpricedCount > 0 && (
          <p className="mt-2 text-sm text-warning">
            {grand.unpricedCount} holding{grand.unpricedCount === 1 ? "" : "s"} unpriced and
            excluded from the total
          </p>
        )}
      </Panel>

      <ChainGroupedHoldings
        groups={groups}
        selectedChain={selectedChain}
        hideSmallActive={hideSmall === "1"}
        baseHref="/assets"
        emptyMessage="No holdings yet — add or sync a wallet to see your assets here."
      />
    </>
  );
}

import { getAssetsGroupedByChain } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { SignInPrompt } from "@/components/SignInPrompt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Portfolio · CryptoPort" };

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; hideUnpriced?: string; hideLow?: string }>;
}) {
  const { chain: selectedChain, hideUnpriced, hideLow } = await searchParams;
  const [{ groups, grand }, user] = await Promise.all([getAssetsGroupedByChain(), getUser()]);

  return (
    <>
      <PageHeader title="Portfolio" subtitle="Every holding across all your wallets, grouped by chain" />

      {user && (
        <TotalValuePanel total={grand.total}>
          {grand.unpricedCount > 0 && (
            <p className="mt-2 text-sm text-warning">
              {grand.unpricedCount} holding{grand.unpricedCount === 1 ? "" : "s"} unpriced and
              excluded from the total
            </p>
          )}
        </TotalValuePanel>
      )}

      {groups.length === 0 && !user ? (
        <SignInPrompt message="Sign up or connect a wallet to start tracking your portfolio." />
      ) : (
        <ChainGroupedHoldings
          groups={groups}
          grandTotal={grand.total}
          selectedChain={selectedChain}
          hideUnpriced={hideUnpriced !== "0"}
          hideLow={hideLow !== "0"}
          baseHref="/portfolio"
          emptyMessage="No holdings yet — add or sync a wallet to see your portfolio here."
        />
      )}
    </>
  );
}

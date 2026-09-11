import { getDefiGroupedByProtocol } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { TotalValuePanel } from "@/components/TotalValuePanel";
import { DefiTable } from "@/components/DefiTable";
import { SignInPrompt } from "@/components/SignInPrompt";

export const dynamic = "force-dynamic";
export const metadata = { title: "DeFi · CryptoPort" };

export default async function DefiPage() {
  const [{ groups, grand }, user] = await Promise.all([getDefiGroupedByProtocol(), getUser()]);

  return (
    <>
      <PageHeader title="DeFi" subtitle="Lending, staking, and other protocol positions, grouped by protocol" />

      {user && (
        <TotalValuePanel total={grand.total}>
          {grand.unpricedCount > 0 && (
            <p className="mt-2 text-sm text-warning">
              {grand.unpricedCount} position{grand.unpricedCount === 1 ? "" : "s"} unpriced and
              excluded from the total
            </p>
          )}
        </TotalValuePanel>
      )}

      {groups.length === 0 ? (
        user ? (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">
              No DeFi positions yet — sync a SOL wallet to pick up Jupiter, Kamino, Wormhole,
              Meteora, or Parcl positions, or an ETH wallet with a Hyperliquid balance.
            </p>
          </Panel>
        ) : (
          <SignInPrompt message="Sign up or connect a wallet to start tracking your DeFi positions." />
        )
      ) : (
        <DefiTable groups={groups} />
      )}
    </>
  );
}

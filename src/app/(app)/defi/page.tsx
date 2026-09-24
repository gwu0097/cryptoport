import { getDefiGroupedByProtocol } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { DefiView } from "@/components/DefiView";
import { GuestBanner } from "@/components/GuestBanner";

export const dynamic = "force-dynamic";
export const metadata = { title: "DeFi · CryptoPort" };

export default async function DefiPage() {
  const [{ groups }, user] = await Promise.all([getDefiGroupedByProtocol(), getUser()]);

  return (
    <>
      <PageHeader title="DeFi" subtitle="Lending, liquidity, staking and other protocol positions, grouped by protocol" />

      {!user && <GuestBanner message="Sign up or connect a wallet to see your own DeFi positions here." />}

      {groups.length === 0 ? (
        user ? (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">
              No DeFi positions yet — sync a SOL wallet to pick up Jupiter, Kamino, Wormhole,
              Meteora, or Parcl positions, or an ETH wallet with a Hyperliquid balance.
            </p>
          </Panel>
        ) : (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">Log in and add a wallet to see your DeFi positions here.</p>
          </Panel>
        )
      ) : (
        // Total panel, All / DeFi / Staking filter and table together: the
        // total follows the filter (see DefiView).
        <DefiView groups={groups} />
      )}
    </>
  );
}

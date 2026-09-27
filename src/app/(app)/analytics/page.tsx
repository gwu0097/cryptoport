import { getUser } from "@/lib/auth";
import { getAnalytics } from "@/lib/analyticsQuery";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { AttributionPanel } from "@/components/analytics/AttributionPanel";
import { RiskPanel } from "@/components/analytics/RiskPanel";
import { HoldingContextTable } from "@/components/analytics/HoldingContextTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics · CryptoPort" };

const SUBTITLE = "What moved your portfolio, how risky it is, and where each holding stands";

export default async function AnalyticsPage() {
  const user = await getUser();
  if (!user) {
    const muted = "Log in and add a wallet to see your analytics here.";
    return (
      <>
        <PageHeader title="Analytics" subtitle={SUBTITLE} />
        <GuestBanner message="Sign up or connect a wallet to see your own analytics here." />
        {["What moved your portfolio", "Risk profile", "Your holdings in context"].map((title) => (
          <Panel key={title} title={title} className="mb-4">
            <p className="text-sm text-fg-muted">{muted}</p>
          </Panel>
        ))}
      </>
    );
  }

  const view = await getAnalytics();
  return (
    <>
      <PageHeader title="Analytics" subtitle={SUBTITLE} />
      {view.unpricedCount > 0 && (
        <p className="mb-4 text-xs text-warning">
          {view.unpricedCount} holdings have no price and are left out of every figure below.
        </p>
      )}
      <AttributionPanel byWindow={view.attribution} byWallet={view.byWallet} />
      <RiskPanel risk={view.risk} totalUsd={view.totalUsd} />
      <HoldingContextTable holdings={view.holdings} smallHoldings={view.smallHoldings} />
    </>
  );
}

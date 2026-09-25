import { requireAdmin } from "@/lib/adminAuth";
import { getPricingCoverage } from "@/lib/pricingCoverageQuery";
import { GAP_LABEL, type GapCause } from "@/lib/pricingCoverage";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { PricingGapsTable } from "@/components/admin/PricingGapsTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pricing coverage · Admin · CryptoPort" };

/**
 * Every coin holding across every user's active wallets that has no price,
 * grouped by why — so a new user's unmatched tokens show up here without
 * anyone reporting them, and each fix to the matching rules is measured by
 * this count going down. Positions (LP, perps) and dollar-only rows are
 * valued without a coin and aren't counted. Assets a sync never fetches (a
 * DeFi protocol with no adapter) can't appear here.
 */
export default async function PricingCoveragePage() {
  await requireAdmin();
  const report = await getPricingCoverage();
  const pct = report.coinHoldings ? ((report.coinHoldings - report.unpriced) / report.coinHoldings) * 100 : 100;
  const causes = (Object.entries(report.byCause) as [GapCause, number][]).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHeader title="Pricing coverage" subtitle="Coin holdings with no price, across every user, and why." />

      <div className="flex flex-col gap-6">
        <Panel>
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums">{pct.toFixed(1)}%</span>{" "}
            <span className="text-fg-muted">
              of {report.coinHoldings} coin holdings are priced · {report.unpriced} unpriced
            </span>
          </p>
          {report.locked > 0 && (
            <p className="mt-1 text-xs text-fg-muted">
              Not counted: {report.locked} holding(s) left unpriced on purpose because they can&apos;t be moved (Sei accounts not linked to an EVM address).
            </p>
          )}
          {causes.length > 0 && (
            <ul className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {causes.map(([cause, n]) => (
                <li key={cause} className="flex justify-between gap-4">
                  <span className="text-fg-muted">{GAP_LABEL[cause]}</span>
                  <span className="tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Unpriced assets">
          {report.gaps.length === 0 ? (
            <p className="text-sm text-fg-muted">Every coin holding has a price.</p>
          ) : (
            <PricingGapsTable gaps={report.gaps} />
          )}
        </Panel>
      </div>
    </>
  );
}

import { requireAdmin } from "@/lib/adminAuth";
import { getPricingCoverage } from "@/lib/pricingCoverageQuery";
import { GAP_LABEL, type GapCause } from "@/lib/pricingCoverage";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { PricingGapsTable } from "@/components/admin/PricingGapsTable";
import { getUnrecognizedCoverage } from "@/lib/unrecognizedTokensQuery";
import { SPAM_LABEL, type SpamSign } from "@/lib/unrecognizedTokens";
import { UnrecognizedCandidatesTable } from "@/components/admin/UnrecognizedCandidatesTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pricing coverage · Admin · CryptoPort" };

/**
 * Every coin holding across every user's active wallets that has no price,
 * grouped by why — so a new user's unmatched tokens show up here without
 * anyone reporting them, and each fix to the matching rules is measured by
 * this count going down. Positions (LP, perps) and dollar-only rows are
 * valued without a coin and aren't counted. Assets a sync never fetches (a
 * DeFi protocol with no adapter) can't appear here. Below it: tokens EVM
 * discovery found that aren't counted at all (wallet_discovered_tokens —
 * no CoinGecko listing or no price), with the ones that don't look like
 * spam listed as candidates to look into.
 */
export default async function PricingCoveragePage() {
  await requireAdmin();
  const [report, unrecognized] = await Promise.all([getPricingCoverage(), getUnrecognizedCoverage()]);
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

        <Panel
          title="Unrecognized tokens"
          description="Held by EVM wallets but not counted: no CoinGecko listing, or no price. Found by balance discovery; never in totals."
        >
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums">{unrecognized.tokens}</span>{" "}
            <span className="text-fg-muted">
              across {unrecognized.wallets} wallet(s) · {unrecognized.bySpam.none} don&apos;t look like spam
            </span>
          </p>
          <ul className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {(Object.keys(SPAM_LABEL) as SpamSign[]).map((sign) => (
              <li key={sign} className="flex justify-between gap-4">
                <span className="text-fg-muted">Spam: {SPAM_LABEL[sign].toLowerCase()}</span>
                <span className="tabular-nums">{unrecognized.bySpam[sign]}</span>
              </li>
            ))}
          </ul>
          {unrecognized.byChain.length > 0 && (
            <p className="mt-4 text-xs text-fg-muted">
              By chain (not spam / total):{" "}
              {unrecognized.byChain.map((c) => `${c.chainName} ${c.notSpam}/${c.tokens}`).join(" · ")}
            </p>
          )}
          {unrecognized.candidates.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-sm text-fg-muted">Most-held tokens that don&apos;t look like spam (top 50):</p>
              <UnrecognizedCandidatesTable rows={unrecognized.candidates} />
            </div>
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

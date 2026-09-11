import { getAssetsGroupedByTicker } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { CheckboxLink } from "@/components/ui/CheckboxLink";
import { AssetsTable } from "@/components/AssetsTable";
import { SignInPrompt } from "@/components/SignInPrompt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets · CryptoPort" };

const LOW_VALUE_USD = 10;

function buildHref(hideUnpriced: boolean, hideLow: boolean): string {
  const params = new URLSearchParams();
  // Both default to checked/true — only recorded in the URL when turned
  // off, so a bare link (e.g. the sidebar) lands on the clean default view.
  if (!hideUnpriced) params.set("hideUnpriced", "0");
  if (!hideLow) params.set("hideLow", "0");
  const qs = params.toString();
  return qs ? `/assets?${qs}` : "/assets";
}

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ hideUnpriced?: string; hideLow?: string }>;
}) {
  const { hideUnpriced: hideUnpricedParam, hideLow: hideLowParam } = await searchParams;
  const hideUnpriced = hideUnpricedParam !== "0";
  const hideLow = hideLowParam !== "0";

  const [{ groups, grand }, user] = await Promise.all([getAssetsGroupedByTicker(), getUser()]);

  // Same semantics as ChainGroupedHoldings: filter which contributing
  // holdings show in a group's breakdown table, but the group's own
  // total/unpricedCount stay as originally computed (not recomputed from
  // the filtered subset) — an asset that's entirely unpriced/low-value
  // drops out of the list entirely once nothing's left to show.
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      holdings: group.holdings.filter((h) => {
        if (h.valuation.kind === "unpriced") return !hideUnpriced;
        if (hideLow && h.valuation.usd < LOW_VALUE_USD) return false;
        return true;
      }),
    }))
    .filter((group) => group.holdings.length > 0);

  return (
    <>
      <PageHeader title="Assets" subtitle="Every token you hold, aggregated across all your wallets" />

      {user && (
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
      )}

      {groups.length === 0 ? (
        user ? (
          <Panel className="text-center">
            <p className="text-sm text-fg-muted">
              No holdings yet — add or sync a wallet to see your assets here.
            </p>
          </Panel>
        ) : (
          <SignInPrompt message="Sign up or connect a wallet to start tracking your portfolio." />
        )
      ) : (
        <>
          <div className="mb-4 flex justify-end gap-4">
            <CheckboxLink
              href={buildHref(!hideUnpriced, hideLow)}
              checked={hideUnpriced}
              label="Hide unpriced"
            />
            <CheckboxLink
              href={buildHref(hideUnpriced, !hideLow)}
              checked={hideLow}
              label={`Hide low price tokens (< $${LOW_VALUE_USD})`}
            />
          </div>

          {visibleGroups.length === 0 ? (
            <Panel className="text-center">
              <p className="text-sm text-fg-muted">Nothing to show here.</p>
            </Panel>
          ) : (
            <AssetsTable groups={visibleGroups} />
          )}
        </>
      )}
    </>
  );
}

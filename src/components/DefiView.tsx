"use client";

import type { DefiProtocolGroup } from "@/lib/queries";
import { groupFamily, type DefiView as View } from "@/lib/nativeStaking";
import { TotalValuePanel } from "./TotalValuePanel";
import { DefiTable } from "./DefiTable";
import { Panel } from "./ui/Panel";
import { ToggleGroup } from "./ui/ToggleGroup";
import { usePersistedState } from "./usePersistedState";

const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "All" },
  { key: "defi", label: "DeFi" },
  { key: "staking", label: "Staking" },
];

/**
 * The DeFi page's All / DeFi / Staking filter (remembered per browser).
 * Staking = native staking only (lib/nativeStaking.ts); app "staking"
 * contracts and liquid staking tokens are DeFi. Filtered in the browser —
 * every group is already on the page — and the total follows the filter.
 */
export function DefiView({ groups }: { groups: DefiProtocolGroup[] }) {
  const [view, setView] = usePersistedState<View>("cryptoport:defiView", "all");
  const shown = groups.filter((g) => {
    if (view === "all") return true;
    const staking = groupFamily(g.wallets.flatMap((w) => w.positions)) !== null;
    return view === "staking" ? staking : !staking;
  });
  const total = shown.reduce((s, g) => s + g.total, 0);
  const unpriced = shown.reduce((s, g) => s + g.unpricedCount, 0);

  return (
    <>
      <TotalValuePanel total={total}>
        {unpriced > 0 && (
          <p className="mt-2 text-sm text-warning">
            {unpriced} position{unpriced === 1 ? "" : "s"} unpriced and excluded from the total
          </p>
        )}
      </TotalValuePanel>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup options={VIEWS} value={view} onChange={setView} />
        <p className="text-xs text-fg-muted">
          {view === "staking"
            ? "Native staking: coins delegated to a validator, unstaked from your wallet with the chain's unbonding period."
            : view === "defi"
              ? "App positions: lending, liquidity, vaults, perps, and tokens staked in an app's own contract."
              : "Staking is native staking only; liquid staking tokens are tokens, or DeFi once deposited in an app."}
        </p>
      </div>

      {shown.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">
            {view === "staking" ? "No native staking positions." : "No DeFi positions in this view."}
          </p>
        </Panel>
      ) : (
        <DefiTable groups={shown} />
      )}
    </>
  );
}

"use client";

import { ASSET_TYPES, topChains, type AssetType, type ChainAllocation } from "@/lib/chainAllocation";
import { formatShare, formatUsd } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { Panel } from "./ui/Panel";
import { Dialog } from "./ui/Dialog";
import { useLazyDialog } from "./ui/useLazyDialog";
import { useHideBalance } from "./HideBalanceProvider";

const MASK = "••••••";
const MAX_ROWS = 8;

const TYPE_COLORS: Record<AssetType, string> = {
  Available: "#3b82f6",
  Staked: "#8b5cf6",
  Rewards: "#f59e0b",
  DeFi: "#14b8a6",
};

type Row = { key: string; name: string; icon: string | null; total: number; byType: Record<AssetType, number> };

/** One chain: its bar length is its value against `barScale` (the whole
 * portfolio on the panel; the largest listed chain in the Other dialog, so
 * small chains stay readable), split into the asset types it holds. The %
 * is always its share of the whole portfolio. `detail` adds the per-type
 * $ split as text (the dialog; hover titles don't exist on touch). */
function ChainRow({ row, total, barScale, hidden, detail = false }: { row: Row; total: number; barScale: number; hidden: boolean; detail?: boolean }) {
  const title = ASSET_TYPES.filter((t) => row.byType[t] > 0)
    .map((t) => `${t}: ${hidden ? MASK : formatUsd(row.byType[t])} (${formatShare(row.byType[t], row.total)})`)
    .join("\n");
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 text-sm text-fg">
        {row.key === "__other__" ? (
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-raised text-[10px] font-medium text-fg-muted">
            ···
          </span>
        ) : (
          <TokenIcon ticker={row.name} url={row.icon} size="sm" />
        )}
        <span className="truncate">{row.name}</span>
      </span>
      <span className="h-2 overflow-hidden rounded-full bg-border" title={title}>
        <span className="flex h-full" style={{ width: `${barScale > 0 ? (row.total / barScale) * 100 : 0}%` }}>
          {ASSET_TYPES.map((t) =>
            row.byType[t] > 0 ? (
              <span key={t} className="h-full" style={{ width: `${(row.byType[t] / row.total) * 100}%`, backgroundColor: TYPE_COLORS[t] }} />
            ) : null,
          )}
        </span>
      </span>
      <span className="flex items-baseline justify-end gap-2 tabular-nums">
        <span className="hidden text-xs text-fg-muted sm:inline">{hidden ? MASK : formatUsd(row.total)}</span>
        <span className="w-12 text-right text-sm text-fg-muted">{formatShare(row.total, total)}</span>
      </span>
      {detail && (
        <span className="col-span-3 -mt-2 text-xs text-fg-muted">
          {ASSET_TYPES.filter((t) => row.byType[t] > 0)
            .map((t) => `${t} ${hidden ? MASK : formatUsd(row.byType[t])}`)
            .join(" · ")}
        </span>
      )}
    </>
  );
}

const GRID = "grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-x-3 gap-y-3";

function toRow(c: ChainAllocation, icons: Record<string, string>): Row {
  return { key: c.chainId, name: c.chainName, icon: icons[c.chainId] ?? null, total: c.total, byType: c.byType };
}

function sumRows(chains: ChainAllocation[]): Record<AssetType, number> {
  const byType = { Available: 0, Staked: 0, Rewards: 0, DeFi: 0 };
  for (const c of chains) for (const t of ASSET_TYPES) byType[t] += c.byType[t];
  return byType;
}

/**
 * Portfolio value by chain, each chain's bar split by asset type — the top
 * eight chains, then "Other (N)", which opens a dialog listing every chain
 * folded into it. Same data and total as the Coin allocation chart beside
 * it (see chainAllocation.ts); $ figures mask under the privacy toggle,
 * percentages and bars stay visible (same reasoning as CoinAllocationChart).
 */
export function ChainAllocationPanel({
  chains,
  total,
  icons,
  className = "",
}: {
  chains: ChainAllocation[];
  total: number;
  icons: Record<string, string>;
  className?: string;
}) {
  const { hidden } = useHideBalance();
  const { dialogRef, open, openDialog } = useLazyDialog();
  const { top, rest } = topChains(chains, MAX_ROWS);
  if (top.length === 0) return null;

  const restTotal = rest.reduce((sum, c) => sum + c.total, 0);
  const allTypes = sumRows([...top, ...rest]);
  const presentTypes = ASSET_TYPES.filter((t) => allTypes[t] > 0);

  return (
    <Panel title="Chain allocation" className={className}>
      <div className={GRID}>
        {top.map((c) => (
          <ChainRow key={c.chainId} row={toRow(c, icons)} total={total} barScale={total} hidden={hidden} />
        ))}
        {rest.length > 0 && (
          <button
            type="button"
            onClick={openDialog}
            className="col-span-3 grid cursor-pointer grid-cols-subgrid items-center rounded-lg text-left hover:bg-surface-raised"
            aria-label={`Show the ${rest.length} other chains`}
          >
            <ChainRow
              row={{ key: "__other__", name: `Other (${rest.length})`, icon: null, total: restTotal, byType: sumRows(rest) }}
              total={total}
              barScale={total}
              hidden={hidden}
            />
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        {presentTypes.map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: TYPE_COLORS[t] }} aria-hidden="true" />
            {t}
          </span>
        ))}
      </div>

      <Dialog ref={dialogRef} title={`Other chains (${rest.length})`}>
        {open && (
          <>
            <p className="mb-4 text-sm text-fg-muted">
              {hidden ? MASK : formatUsd(restTotal)} · {formatShare(restTotal, total)} of the portfolio.
            </p>
            <div className={GRID}>
              {rest.map((c) => (
                <ChainRow key={c.chainId} row={toRow(c, icons)} total={total} barScale={rest[0].total} hidden={hidden} detail />
              ))}
            </div>
          </>
        )}
      </Dialog>
    </Panel>
  );
}

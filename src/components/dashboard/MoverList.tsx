import type { AssetGroup } from "@/lib/queries";
import { formatUsd, formatPercent } from "@/lib/format";
import { TokenIcon } from "../TokenIcon";
import { Panel } from "../ui/Panel";

/** Same green/red/muted convention as AssetsTable.tsx's ChangeCell,
 * duplicated rather than imported — that file's own ProtocolTag comment
 * documents this precedent (surrounding markup differs enough that a
 * shared component would need its own prop-plumbing for no real benefit). */
function ChangeText({ value }: { value: number | null }) {
  const className = value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} text-sm font-medium tabular-nums`}>{formatPercent(value)}</span>;
}

export function MoverList({ title, groups }: { title: string; groups: AssetGroup[] }) {
  return (
    <Panel title={title}>
      {groups.length === 0 ? (
        <p className="text-sm text-fg-muted">Not enough 24h data yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((g) => (
            <li key={g.tickerKey} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <TokenIcon ticker={g.ticker} url={g.iconUrl} />
                <span className="truncate text-sm font-medium text-fg">{g.ticker}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {/* Per-unit price, not the user's own position value (g.total)
                    — a "Top gainers/losers" ticker list means the market
                    price, matching AssetsTable's own price column; showing
                    position size here read as a wrong/implausible price
                    (e.g. a $54 ETH "price" that was really a small position's
                    USD value). */}
                <span className="text-sm tabular-nums text-fg-muted">
                  {g.price !== null ? formatUsd(g.price) : "—"}
                </span>
                <ChangeText value={g.change24h} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

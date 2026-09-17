import { formatUsd, formatPercent } from "@/lib/format";
import { TokenIcon } from "../TokenIcon";
import { Panel } from "../ui/Panel";

/** The narrow shape MoverList actually needs — deliberately not AssetGroup
 * (which carries `total`/`holdings`/unpriced-count, all Holdings-specific
 * and meaningless for a Watchlist coin that isn't held). This is the
 * second caller (Holdings movers, Watchlist movers) needing the exact same
 * ticker+price+change24h row shape, which is this codebase's own stated
 * threshold for extracting a shared type rather than either duplicating
 * this component or forcing one caller's data to pretend to be the
 * other's. `key` is the caller's own unique id (AssetGroup.tickerKey for
 * Holdings, coingeckoId for Watchlist) since the two sources have no
 * shared identity scheme. */
export interface MoverItem {
  key: string;
  ticker: string;
  iconUrl: string | null;
  price: number | null;
  change24h: number | null;
}

/** Same green/red/muted convention as AssetsTable.tsx's ChangeCell,
 * duplicated rather than imported — that file's own ProtocolTag comment
 * documents this precedent (surrounding markup differs enough that a
 * shared component would need its own prop-plumbing for no real benefit). */
function ChangeText({ value }: { value: number | null }) {
  const className = value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} text-sm font-medium tabular-nums`}>{formatPercent(value)}</span>;
}

export function MoverList({ title, items }: { title: string; items: MoverItem[] }) {
  return (
    <Panel title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">Not enough 24h data yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.key} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <TokenIcon ticker={item.ticker} url={item.iconUrl} />
                <span className="truncate text-sm font-medium text-fg">{item.ticker}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {/* Per-unit price, not the user's own position value — a
                    "Top gainers/losers" ticker list means the market
                    price, matching AssetsTable's own price column; showing
                    position size here read as a wrong/implausible price
                    (e.g. a $54 ETH "price" that was really a small position's
                    USD value). Watchlist items have no position at all, so
                    this is the only sensible number to show either way. */}
                <span className="text-sm tabular-nums text-fg-muted">
                  {item.price !== null ? formatUsd(item.price) : "—"}
                </span>
                <ChangeText value={item.change24h} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

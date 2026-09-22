import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, TrendingUp, BookOpen } from "lucide-react";
import { formatUsd, formatPercent } from "@/lib/format";
import { TokenIcon } from "../TokenIcon";
import { Panel } from "../ui/Panel";
import { MoverHoldingValue } from "./MoverHoldingValue";

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
  /** A real CoinGecko id, when the caller already has one — Watchlist rows
   * do (WatchlistRow.coingeckoId), Holdings rows don't (AssetGroup is
   * ticker-grouped across chains/contracts with no stored id — see Trend
   * Finder's own ?ticker= fallback path for how that gets resolved
   * instead). Drives whether the "Find Trend" link below uses the
   * unambiguous ?id= or the best-effort ?ticker=. */
  coingeckoId?: string;
  /** How much of this ticker the user actually holds, in USD — undefined
   * (not 0) when they don't hold it at all, which is the normal case for
   * every Watchlist row that isn't also a real position. Holdings rows
   * always have one (AssetGroup.total); Watchlist rows only get one when
   * the same ticker shows up in the user's own holdings too. Masked by
   * MoverHoldingValue behind the shared privacy toggle — see that
   * component's own doc comment for why (a position size reveals
   * portfolio size; the row's own market price doesn't). */
  holdingValueUsd?: number;
}

/** Same green/red/muted convention as AssetsTable.tsx's ChangeCell,
 * duplicated rather than imported — that file's own ProtocolTag comment
 * documents this precedent (surrounding markup differs enough that a
 * shared component would need its own prop-plumbing for no real benefit). */
function ChangeText({ value }: { value: number | null }) {
  const className = value === null ? "text-fg-muted" : value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-fg-muted";
  return <span className={`${className} text-sm font-medium tabular-nums`}>{formatPercent(value)}</span>;
}

/**
 * `href` — set by dashboard/page.tsx to the full list (Assets or
 * Watchlist) pre-sorted by the same 24h-change direction this panel is
 * showing (`?sort=change24h&dir=desc|asc`), so clicking through the 5-row
 * preview lands on the full list in the same order — "go from the 5
 * tokens to the full list," per the direct ask. The whole title row is
 * the click target (not a separate small "view all" link) since a Panel
 * title with nothing else interactive in it is an obvious, low-risk place
 * to put one extra affordance rather than adding new chrome.
 *
 * `filter` — an interactive control (Dashboard's watchlist `<select>`)
 * rendered inline in the title, replacing the plain "· {name}" text a
 * static suffix would otherwise need — reported directly: a separate row
 * above both panels plus each title repeating the selected list's name
 * said it three times over. Pulled out of the title Link (a `<select>`
 * nested inside an `<a>` is both invalid and fights the anchor's own
 * click handling), so this one case gets its own two-Link layout instead
 * of the single wrapping Link every other caller still uses unchanged.
 */
export function MoverList({
  title,
  items,
  href,
  filter,
}: {
  title: string;
  items: MoverItem[];
  href: string;
  filter?: ReactNode;
}) {
  return (
    <Panel
      title={
        filter ? (
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <Link href={href} className="truncate hover:text-accent">
                {title}
              </Link>
              <span className="text-fg-muted">·</span>
              {filter}
            </span>
            <Link href={href} aria-label={`View all — ${title}`} className="text-fg-muted transition hover:text-accent">
              <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <Link href={href} className="flex items-center justify-between gap-2 hover:text-accent">
            {title}
            <ChevronRight className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
          </Link>
        )
      }
    >
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">Not enough 24h data yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.key} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <TokenIcon ticker={item.ticker} url={item.iconUrl} />
                <span className="truncate text-sm font-medium text-fg">{item.ticker}</span>
                <MoverHoldingValue usd={item.holdingValueUsd} />
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
                <Link
                  href={
                    item.coingeckoId
                      ? `/trend-finder?id=${encodeURIComponent(item.coingeckoId)}`
                      : `/trend-finder?ticker=${encodeURIComponent(item.ticker)}`
                  }
                  aria-label={`Find sector peers for ${item.ticker}`}
                  title="Find sector peers"
                  className="text-fg-muted transition hover:text-accent"
                >
                  <TrendingUp className="size-3.5" aria-hidden="true" />
                </Link>
                <Link
                  href={
                    item.coingeckoId
                      ? `/encyclopedia?id=${encodeURIComponent(item.coingeckoId)}`
                      : `/encyclopedia?ticker=${encodeURIComponent(item.ticker)}`
                  }
                  aria-label={`Open ${item.ticker} in Encyclopedia`}
                  title="Open in Encyclopedia"
                  className="text-fg-muted transition hover:text-accent"
                >
                  <BookOpen className="size-3.5" aria-hidden="true" />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

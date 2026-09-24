"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ArrowUp, ArrowDown, ChevronsUpDown, ChevronRight, ChevronDown, ExternalLink } from "lucide-react";
import type { DefiProtocolGroup } from "@/lib/queries";
import { formatUsd, formatUsdSigned, formatPercent, formatQty, formatTicker } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "./ui/table";
import { TokenIcon } from "./TokenIcon";
import { usePersistedState } from "./usePersistedState";
import { groupBySection } from "@/lib/holdingSections";
import { groupFamily, stakingLinks } from "@/lib/nativeStaking";
import type { DefiSortKey, SortDirection } from "@/lib/sortKeys";

// DefiSortKey lives in lib/sortKeys.ts, not here — a plain runtime constant
// declared in a "use client" file becomes an opaque client-reference stub
// when a Server Component imports it directly (see that file's own
// comment for the real bug this avoided on assets/page.tsx/watchlist/
// page.tsx). No Server Component currently needs DEFI_SORT_KEYS, but the
// split keeps this file consistent with AssetsTable/WatchlistTable's own
// pattern rather than being the one exception.
export type SortKey = DefiSortKey;
export type Sort = { key: SortKey; dir: SortDirection };

const STORAGE_KEY = "cryptoport:defiSort";
const DEFAULT_SORT: Sort = { key: "value", dir: "desc" };
const HIDE_UNPRICED_KEY = "cryptoport:defiHideUnpriced";
const HIDE_LOW_KEY = "cryptoport:defiHideLow";
const LOW_VALUE_USD = 10;

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// Same badge as HoldingsTable's own PositionTag — duplicated rather than
// shared, same reasoning as this file's ProtocolTag-equivalent inline
// markup: the surrounding row shape differs enough (no sort/edit column
// here) that a shared component would need its own prop-plumbing for a
// handful of lines. The Value column is margin committed (see
// hyperliquid.ts's own doc comment), not signed, so PnL is shown here
// instead as its own colored stat.
function PositionTag({
  side,
  leverage,
  entryPrice,
  liquidationPrice,
  pnl,
  pnlPercent,
}: {
  // Optional — a Polymarket prediction has its own PnL with no leverage/
  // side concept at all (see hyperliquid.ts and polymarket.ts's own doc
  // comments on position_pnl_usd).
  side: "long" | "short" | null;
  leverage: unknown;
  entryPrice: unknown;
  liquidationPrice: unknown;
  pnl: unknown;
  pnlPercent: unknown;
}) {
  const lev = numeric(leverage);
  const entry = numeric(entryPrice);
  const liq = numeric(liquidationPrice);
  const pnlNum = numeric(pnl);
  const pnlPercentNum = numeric(pnlPercent);
  const label = side ? `${side === "long" ? "Long" : "Short"}${Number.isFinite(lev) ? ` ${lev}x` : ""}` : null;
  const details = [
    Number.isFinite(entry) ? `entry ${formatUsd(entry)}` : null,
    Number.isFinite(liq) ? `liq. ${formatUsd(liq)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="flex items-center gap-1.5 text-xs" title={details || undefined}>
      {label && <span className="text-fg-muted">{label}</span>}
      {Number.isFinite(pnlNum) && (
        <span className={pnlNum > 0 ? "text-positive" : pnlNum < 0 ? "text-negative" : "text-fg-muted"}>
          PnL {formatUsdSigned(pnlNum)}
          {Number.isFinite(pnlPercentNum) && <> ({formatPercent(pnlPercentNum)})</>}
        </span>
      )}
    </span>
  );
}

function sortValue(group: DefiProtocolGroup, key: SortKey): number | string {
  switch (key) {
    case "protocol":
      return group.protocol.toLowerCase();
    case "wallets":
      return group.wallets.length;
    case "value":
      return group.total;
  }
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDirection }) {
  if (!active) return <ChevronsUpDown className="size-3 text-fg-muted/50" aria-hidden="true" />;
  return dir === "desc" ? (
    <ArrowDown className="size-3" aria-hidden="true" />
  ) : (
    <ArrowUp className="size-3" aria-hidden="true" />
  );
}

function Header({
  label,
  sortKeyValue,
  sortKey,
  sortDir,
  onSort,
  className = "",
}: {
  label: string;
  sortKeyValue: SortKey;
  sortKey: SortKey;
  sortDir: SortDirection;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  return (
    <th className={`${thClass} ${className}`}>
      <button type="button" onClick={() => onSort(sortKeyValue)} className="flex items-center gap-1 hover:text-fg">
        {label}
        <SortIcon active={sortKey === sortKeyValue} dir={sortDir} />
      </button>
    </th>
  );
}

/**
 * One flat, sortable table — one row per protocol, merged across every
 * wallet holding a position in it (see getDefiGroupedByProtocol) — replacing
 * the old always-open `<details>` stack, which had no sort at all and read
 * nothing like WalletsTable/AssetsTable (reported as "stale," "nothing like
 * the other tabs"). Sortable by Wallets (count) specifically so a protocol
 * spread across many wallets is easy to spot and jump into — the ask that
 * prompted this rewrite ("sort by wallets so it's easier to navigate") —
 * mirrors the identical sortable "Wallets" column AssetsTable already has
 * for tickers, same idea one page over.
 *
 * Clicking a row expands it in place (AssetsTable's pattern, not a
 * navigate-away) to reveal the per-wallet breakdown — wallet name (linking
 * to that wallet's own page), its subtotal, and its individual positions —
 * so merging protocols across wallets doesn't lose the "which wallet is
 * this actually in" context needed to act on it.
 */
export function DefiTable({ groups }: { groups: DefiProtocolGroup[] }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const { key: sortKey, dir: sortDir } = sort;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hideUnpriced, setHideUnpriced] = usePersistedState(HIDE_UNPRICED_KEY, false);
  const [hideLow, setHideLow] = usePersistedState(HIDE_LOW_KEY, false);

  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  function toggleExpand(protocol: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(protocol)) next.delete(protocol);
      else next.add(protocol);
      return next;
    });
  }

  // Only the expanded per-wallet position lists are filtered — the
  // Protocol/Wallets/Value columns keep showing their real, unfiltered
  // totals (same choice ChainGroupedHoldings makes: the filter controls
  // which rows are visible, never what a total silently adds up to). A
  // wallet whose every position gets filtered out drops from the expanded
  // view entirely rather than showing an empty position table under it.
  function visiblePositions(positions: DefiProtocolGroup["wallets"][number]["positions"]) {
    return positions.filter((p) => {
      if (p.valuation.kind === "unpriced") return !hideUnpriced;
      if (hideLow && p.valuation.usd < LOW_VALUE_USD) return false;
      return true;
    });
  }

  const sorted = [...groups].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-4 p-4 pb-3">
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={hideUnpriced}
            onChange={(e) => setHideUnpriced(e.target.checked)}
            className="size-4 rounded border-border accent-accent"
          />
          Hide unpriced
        </label>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={hideLow}
            onChange={(e) => setHideLow(e.target.checked)}
            className="size-4 rounded border-border accent-accent"
          />
          Hide low value (&lt; ${LOW_VALUE_USD})
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              <th className={thClass}></th>
              <Header label="Protocol" sortKeyValue="protocol" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Header
                label="Wallets"
                sortKeyValue="wallets"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={toggleSort}
                className={hideOnMobileClass}
              />
              <Header label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((group) => {
              const isOpen = expanded.has(group.protocol);
              // First position's own icon stands in for the protocol's —
              // same trick ChainGroupedHoldings' ProtocolGroup uses (its own
              // doc comment: every holding within one protocol group shares
              // the same underlying asset in practice), no separate
              // per-protocol icon source exists.
              const repHolding = group.wallets[0]?.positions[0];
              // Native staking groups get where-to-unstake links instead of
              // the plain protocol link (lib/nativeStaking.ts).
              const family = groupFamily(group.wallets.flatMap((w) => w.positions));
              const links = family ? stakingLinks(family, repHolding?.protocol_url ?? null) : null;
              return (
                <Fragment key={group.protocol}>
                  <tr
                    className={`${trClass} cursor-pointer`}
                    onClick={() => toggleExpand(group.protocol)}
                    aria-expanded={isOpen}
                  >
                    <td className={tdClass}>
                      {isOpen ? (
                        <ChevronDown className="size-4 text-fg-muted" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-4 text-fg-muted" aria-hidden="true" />
                      )}
                    </td>
                    <td className={tdClass}>
                      <div className="flex items-center gap-2">
                        {repHolding && <TokenIcon ticker={repHolding.ticker} url={repHolding.icon_url} />}
                        <div className="min-w-0">
                        <span className="font-medium text-fg">{group.protocol}</span>
                        {links && (
                          <div className="flex flex-wrap gap-x-3 text-xs">
                            {links.manage ? (
                              <a href={links.manage.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
                                {links.manage.label}
                              </a>
                            ) : (
                              <span className="text-fg-muted">Manage in your wallet</span>
                            )}
                            <a href={links.guide.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
                              {links.guide.label}
                            </a>
                          </div>
                        )}
                        </div>
                        {/* Every position within one protocol group shares the
                            same protocol_url in practice (same adapter, same
                            product) — same "first holding stands in for the
                            group" reasoning already used for the icon above. */}
                        {!links && repHolding?.protocol_url && (
                          <a
                            href={repHolding.protocol_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${group.protocol}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-fg-muted hover:text-accent"
                          >
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{group.wallets.length}</td>
                    <td className={`${tdClass} tabular-nums`}>
                      {formatUsd(group.total)}
                      {group.unpricedCount > 0 && <span className="ml-1.5 text-xs text-warning">*</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={4} className="bg-surface-raised/40 p-0">
                        <div className="flex flex-col divide-y divide-border">
                          {group.wallets.map((w) => {
                            const positions = visiblePositions(w.positions);
                            if (positions.length === 0) return null;
                            return (
                            <div key={w.walletId} className="px-5 py-3">
                              <div className="mb-2 flex items-center justify-between">
                                <Link
                                  href={`/wallets/${w.walletId}`}
                                  className="text-sm font-medium text-fg hover:text-accent"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {w.walletName}
                                </Link>
                                <span className="tabular-nums text-sm text-fg-muted">{formatUsd(w.total)}</span>
                              </div>
                              {groupBySection(positions).map(({ section, holdings: sectionPositions }, i) => (
                                <div key={section ?? "_"} className={i > 0 ? "mt-3" : undefined}>
                                  {section && (
                                    <p className="pb-1 text-xs font-medium text-fg-muted">{section}</p>
                                  )}
                                  <div className="overflow-x-auto">
                                    <table className={tableClass}>
                                      <thead>
                                        <tr className={theadRowClass}>
                                          <th className={thClass}>Asset</th>
                                          <th className={`${thClass} ${hideOnMobileClass}`}>Qty</th>
                                          <th className={thClass}>Value</th>
                                          <th className={thClass}></th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {sectionPositions.map((position) => (
                                          <tr key={position.id} className={trClass}>
                                            <td className={tdClass}>
                                              <div className="flex flex-col gap-0.5">
                                                <div className="flex items-center gap-2">
                                                  <TokenIcon ticker={position.ticker} url={position.icon_url} />
                                                  {position.display_label ?? formatTicker(position.ticker)}
                                                </div>
                                                {(position.position_side || position.position_pnl_usd != null) && (
                                                  <PositionTag
                                                    side={position.position_side}
                                                    leverage={position.position_leverage}
                                                    entryPrice={position.position_entry_price}
                                                    liquidationPrice={position.position_liquidation_price}
                                                    pnl={position.position_pnl_usd}
                                                    pnlPercent={position.position_pnl_percent}
                                                  />
                                                )}
                                              </div>
                                            </td>
                                            <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                                              {formatQty(position.qty)}
                                            </td>
                                            <td className={`${tdClass} tabular-nums`}>
                                              {position.valuation.kind === "priced" ? (
                                                formatUsd(position.valuation.usd)
                                              ) : (
                                                <span className="text-warning">unpriced</span>
                                              )}
                                            </td>
                                            <td className={tdClass}>
                                              {position.protocol_url && (
                                                <a
                                                  href={position.protocol_url}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="inline-flex items-center gap-0.5 text-xs text-fg-muted hover:text-accent"
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  View <ExternalLink className="size-2.5" aria-hidden="true" />
                                                </a>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ))}
                            </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { getChainIconMap, type ChainGroup, type HoldingWithValuation } from "@/lib/queries";
import { formatUsd, formatTicker } from "@/lib/format";
import { groupBySection } from "@/lib/holdingSections";
import { Panel } from "./ui/Panel";
import { HoldingsTable } from "./HoldingsTable";
import { TokenIcon } from "./TokenIcon";
import { CheckboxLink } from "./ui/CheckboxLink";
import { StopPropagationLink } from "./StopPropagationLink";
import { CollapseExpandAllButtons } from "./CollapseExpandAllButtons";

const LOW_VALUE_USD = 10;
const GROUPS_CONTAINER_ID = "chain-grouped-holdings";

interface ProtocolGroup {
  protocol: string;
  url: string | null;
  total: number;
  holdings: HoldingWithValuation[];
  /** From the group's first holding — every holding within one protocol
   * group shares the same underlying asset in practice (e.g. every
   * "Solana Staking: X" row is SOL), so reusing its own already-fetched
   * ticker/icon_url is enough to icon the section header, no separate
   * per-protocol icon source needed. */
  ticker: string;
  icon: string | null;
}

/**
 * Splits one chain's holdings into plain token balances and DeFi-product
 * sub-groups (jup.ag's own "Validators"/"Solana Mobile"/"Jito" cards are
 * exactly this idea) — reported directly that a single flat table lumping
 * 11 near-identical native-staking rows next to one Jito row made the
 * Jito position easy to miss entirely, even though it was confirmed
 * present and correctly priced on every check. Protocol groups sorted by
 * descending value, same convention getDefiGroupedByProtocol (the /defi
 * page's own cross-wallet version of this grouping) already uses.
 */
function groupByProtocol(holdings: HoldingWithValuation[]): {
  plain: HoldingWithValuation[];
  protocolGroups: ProtocolGroup[];
} {
  const plain: HoldingWithValuation[] = [];
  const byProtocol = new Map<string, ProtocolGroup>();
  for (const holding of holdings) {
    if (!holding.protocol) {
      plain.push(holding);
      continue;
    }
    let group = byProtocol.get(holding.protocol);
    if (!group) {
      group = {
        protocol: holding.protocol,
        url: holding.protocol_url,
        total: 0,
        holdings: [],
        ticker: holding.ticker,
        icon: holding.icon_url,
      };
      byProtocol.set(holding.protocol, group);
    }
    group.holdings.push(holding);
    if (holding.valuation.kind === "priced") group.total += holding.valuation.usd;
  }
  const protocolGroups = [...byProtocol.values()].sort((a, b) => b.total - a.total);
  return { plain, protocolGroups };
}

/**
 * The same per-protocol totals as groupByProtocol, but flattened across
 * every chain in scope instead of one chain at a time — the second
 * navigation row (protocol cards, mirroring the existing chain cards)
 * needs "how much do I have in Hyperliquid total," not "how much in
 * Hyperliquid within just Ethereum." Always computed from the raw,
 * unfiltered `groups` (same "summary chip shows the true total" rule as
 * the chain cards below) — DeBank's own portfolio view is the direct
 * precedent for this second row.
 */
function summarizeProtocols(groups: ChainGroup[]): ProtocolGroup[] {
  const byProtocol = new Map<string, ProtocolGroup>();
  for (const g of groups) {
    for (const holding of g.holdings) {
      if (!holding.protocol) continue;
      let group = byProtocol.get(holding.protocol);
      if (!group) {
        group = {
          protocol: holding.protocol,
          url: holding.protocol_url,
          total: 0,
          holdings: [],
          ticker: holding.ticker,
          icon: holding.icon_url,
        };
        byProtocol.set(holding.protocol, group);
      }
      group.holdings.push(holding);
      if (holding.valuation.kind === "priced") group.total += holding.valuation.usd;
    }
  }
  return [...byProtocol.values()].sort((a, b) => b.total - a.total);
}

/**
 * What "disappeared" after the hideUnpriced/hideLow filters ran, at
 * whichever granularity the caller cares about (a whole chain, a DeFi
 * protocol group within a chain, or an individual plain holding within a
 * chain) — `raw` and `visible` are both keyed the same way via `keyFn`;
 * anything in `raw` but not `visible` counts as hidden. Extracted once a
 * third copy of the identical "diff raw vs visible, tell the user what
 * vanished" logic showed up below, past this codebase's own "two is the
 * threshold to extract" rule.
 */
function findHidden<T>(raw: T[], visible: T[], keyFn: (item: T) => string): T[] {
  const visibleKeys = new Set(visible.map(keyFn));
  return raw.filter((item) => !visibleKeys.has(keyFn(item)));
}

/** A chain's summary chip always shows its real, unfiltered total, but its
 * detail panel(s) only render what survives the filters — without this,
 * a holding (or a whole chain, or one DeFi product within a chain) that's
 * real, priced, and simply small or unpriced would vanish with zero
 * explanation: the chip (or a sibling row) promises data, nothing shows
 * why some of it is missing. Reported directly, twice, at two different
 * granularities, as "don't see anything" / "why is there a gap." `total`
 * omitted (e.g. for a plain unpriced holding, which by definition has no
 * reliable USD figure to show) renders just the label. */
function HiddenByFiltersNotice({
  items,
  className,
}: {
  items: { label: string; total?: number }[];
  className: string;
}) {
  if (items.length === 0) return null;
  return (
    <p className={className}>
      {items.map((i) => (i.total !== undefined ? `${i.label} (${formatUsd(i.total)})` : i.label)).join(", ")} hidden
      by the filters above.
    </p>
  );
}

function cardClass(active: boolean): string {
  const base = "rounded-lg border px-3 py-2 text-left transition";
  return active
    ? `${base} border-accent bg-surface-raised`
    : `${base} border-border bg-surface hover:border-accent/50 hover:bg-surface-raised`;
}

// baseHref may itself already carry a query string (the lookup page bakes
// `address` into it, since that has to survive every filter/chain click) —
// parsed out and merged rather than assumed empty. chain/protocol are
// mutually exclusive — picking one clears the other, since "which chain"
// and "which protocol" are two different ways to slice the same data, not
// two filters meant to combine (see ChainGroupedHoldings' own doc comment).
function buildHref(
  baseHref: string,
  chain: string | undefined,
  protocol: string | undefined,
  hideUnpriced: boolean,
  hideLow: boolean,
): string {
  const [path, existingQs] = baseHref.split("?");
  const params = new URLSearchParams(existingQs);
  if (chain) params.set("chain", chain);
  else params.delete("chain");
  if (protocol) params.set("protocol", protocol);
  else params.delete("protocol");
  // Both default to checked/true — only recorded in the URL when turned off,
  // so a bare link (e.g. the sidebar) lands on the clean default view.
  if (!hideUnpriced) params.set("hideUnpriced", "0");
  else params.delete("hideUnpriced");
  if (!hideLow) params.set("hideLow", "0");
  else params.delete("hideLow");
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The $/% summary cards double as the chain filter (click a card to dive
 * into that chain, click "All chains" to go back) — one control instead of
 * a summary grid plus a separate, redundant pill row. Below that,
 * collapsible per-chain sections (native <details>/<summary>, no client JS
 * for the shell — only the table rows inside are interactive, for
 * sorting). Shared by the cross-wallet Assets page and a single auto
 * wallet's detail page, both of which have the same "one entity spans many
 * chains" shape.
 *
 * `walletId`, when given, makes any manually-added holding in the mix
 * editable/deletable (see HoldingsTable) — omitted on the Assets and
 * lookup pages, where a holding either spans many wallets or belongs to no
 * saved wallet, so there's no single wallet_id an edit/delete action could
 * target.
 *
 * `actions`, when given, renders next to the hide-unpriced/hide-low
 * checkboxes — "under chains, before the token list" (e.g. the wallet
 * detail page's "+ Add holding" button). Rendered even when there are no
 * holdings yet, since adding the first one is exactly when it matters most.
 */
export async function ChainGroupedHoldings({
  groups,
  grandTotal,
  selectedChain,
  selectedProtocol,
  hideUnpriced,
  hideLow,
  baseHref,
  emptyMessage = "No holdings yet.",
  walletId,
  actions,
}: {
  groups: ChainGroup[];
  grandTotal: number;
  selectedChain?: string;
  selectedProtocol?: string;
  hideUnpriced: boolean;
  hideLow: boolean;
  baseHref: string;
  emptyMessage?: string;
  walletId?: string;
  actions?: ReactNode;
}) {
  if (groups.length === 0) {
    return (
      <>
        {actions && <div className="mb-4">{actions}</div>}
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">{emptyMessage}</p>
        </Panel>
      </>
    );
  }

  const chainIcons = await getChainIconMap();
  const protocolSummaries = summarizeProtocols(groups);

  const visibleGroups = groups
    .filter((g) => !selectedChain || g.chainId === selectedChain)
    .map((g) => ({
      ...g,
      holdings: g.holdings.filter((h) => {
        if (selectedProtocol && h.protocol !== selectedProtocol) return false;
        if (h.valuation.kind === "unpriced") return !hideUnpriced;
        if (hideLow && h.valuation.usd < LOW_VALUE_USD) return false;
        return true;
      }),
    }))
    .filter((g) => g.holdings.length > 0);

  const rawGroupsInScope = groups.filter((g) => !selectedChain || g.chainId === selectedChain);
  // Skipped while a protocol filter is active — every chain missing from
  // visibleGroups there is because it simply has no holdings in that
  // protocol, not because the hideUnpriced/hideLow checkboxes (what this
  // notice is actually about) ate something.
  const hiddenGroups = selectedProtocol
    ? []
    : findHidden(rawGroupsInScope.filter((g) => g.holdings.length > 0), visibleGroups, (g) => g.chainId);

  return (
    <>
      <div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        <Link
          href={buildHref(baseHref, undefined, undefined, hideUnpriced, hideLow)}
          className={cardClass(!selectedChain && !selectedProtocol)}
        >
          <p className="text-sm font-medium text-fg">All chains</p>
          <p className="tabular-nums text-xs text-fg-muted">{formatUsd(grandTotal)} · 100%</p>
        </Link>
        {groups.map((g) => (
          <Link
            key={g.chainId}
            href={buildHref(baseHref, g.chainId, undefined, hideUnpriced, hideLow)}
            className={cardClass(selectedChain === g.chainId)}
          >
            <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
              <TokenIcon ticker={g.chainName} url={chainIcons[g.chainId] ?? null} />
              {g.chainName}
            </p>
            <p className="tabular-nums text-xs text-fg-muted">
              {formatUsd(g.total)}
              {grandTotal > 0 && <> · {((g.total / grandTotal) * 100).toFixed(0)}%</>}
            </p>
          </Link>
        ))}
      </div>

      {/* Second navigation row, same idea as the chain cards above but
          cutting across chains by protocol instead — DeBank's own
          portfolio view pairs these two rows the same way. Mutually
          exclusive with the chain selection (see buildHref's own doc
          comment): picking a protocol here clears any chain filter, and
          vice versa. Omitted entirely when nothing in scope has a protocol
          at all (a wallet/lookup with only plain token balances). */}
      {protocolSummaries.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
          {protocolSummaries.map((pg) => (
            <Link
              key={pg.protocol}
              href={buildHref(baseHref, undefined, pg.protocol, hideUnpriced, hideLow)}
              className={cardClass(selectedProtocol === pg.protocol)}
            >
              <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                <TokenIcon ticker={pg.ticker} url={pg.icon} />
                {pg.protocol}
              </p>
              <p className="tabular-nums text-xs text-fg-muted">
                {formatUsd(pg.total)}
                {grandTotal > 0 && <> · {((pg.total / grandTotal) * 100).toFixed(0)}%</>}
              </p>
            </Link>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>{actions}</div>
        <div className="flex flex-wrap items-center gap-4">
          <CollapseExpandAllButtons containerId={GROUPS_CONTAINER_ID} />
          <CheckboxLink
            href={buildHref(baseHref, selectedChain, selectedProtocol, !hideUnpriced, hideLow)}
            checked={hideUnpriced}
            label="Hide unpriced"
          />
          <CheckboxLink
            href={buildHref(baseHref, selectedChain, selectedProtocol, hideUnpriced, !hideLow)}
            checked={hideLow}
            label={`Hide low price tokens (< $${LOW_VALUE_USD})`}
          />
        </div>
      </div>

      <HiddenByFiltersNotice
        items={hiddenGroups.map((g) => ({ label: g.chainName, total: g.total }))}
        className="mb-4 text-sm text-fg-muted"
      />

      {visibleGroups.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">Nothing to show here.</p>
        </Panel>
      ) : (
        <div id={GROUPS_CONTAINER_ID} className="flex flex-col gap-4">
          {visibleGroups.map((group) => {
            const { plain, protocolGroups } = groupByProtocol(group.holdings);
            // The page-level notice above only catches a chain that
            // disappears entirely. A chain that STAYS visible (this one
            // has other, larger holdings) can still silently drop one
            // specific DeFi product, or one plain token, whose only
            // holding(s) were individually filtered out (below the
            // low-value cutoff, or unpriced) — e.g. a $7.88 Lulo position
            // sitting right next to a $3,000+ one in the same "Solana
            // DeFi" chain, or an illiquid token with no reliable price
            // sitting next to a priced one in "Solana". Comparing this
            // chain's raw holdings against what actually rendered, at
            // both granularities, catches those too.
            const rawGroup = groups.find((g) => g.chainId === group.chainId);
            const rawProtocolGroups = rawGroup ? groupByProtocol(rawGroup.holdings).protocolGroups : [];
            // Same reasoning as the top-level hiddenGroups above — with a
            // protocol filter active, "everything except that protocol" is
            // hidden by construction, not by hideUnpriced/hideLow, so these
            // two notices would otherwise list nearly this chain's entire
            // raw contents right back at the user.
            const hiddenProtocolGroups = selectedProtocol
              ? []
              : findHidden(rawProtocolGroups, protocolGroups, (pg) => pg.protocol);
            const rawPlain = rawGroup?.holdings.filter((h) => !h.protocol) ?? [];
            const hiddenPlain = selectedProtocol ? [] : findHidden(rawPlain, plain, (h) => h.id);
            // The chain summary line always shows this chain's true total
            // (matching hideUnpriced/hideLow's own "chip stays true, detail
            // panel filters" convention) — except under a protocol filter,
            // where showing e.g. "Ethereum $47,000" right above a view of
            // only its $13,000 Hyperliquid slice reads as a contradiction,
            // not a summary. There the header narrows to match what's
            // actually shown: just that protocol's contribution here.
            const displayTotal = selectedProtocol
              ? group.holdings.reduce((sum, h) => (h.valuation.kind === "priced" ? sum + h.valuation.usd : sum), 0)
              : group.total;
            return (
              <details key={group.chainId} open className="group rounded-xl border border-border bg-surface">
                <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2 font-semibold text-fg">
                    <ChevronDown
                      className="size-4 text-fg-muted transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    />
                    <TokenIcon ticker={group.chainName} url={chainIcons[group.chainId] ?? null} />
                    {group.chainName}
                    <span className="text-sm font-normal text-fg-muted">
                      ({group.holdings.length} holding{group.holdings.length === 1 ? "" : "s"})
                    </span>
                  </span>
                  <span className="tabular-nums text-fg">{formatUsd(displayTotal)}</span>
                </summary>
                <div className="border-t border-border">
                  {plain.length > 0 && (
                    <div>
                      {/* Only labeled when DeFi sub-groups also exist below
                          — otherwise this is the overwhelmingly common
                          case (a chain with no DeFi at all) and stays
                          pixel-identical to before this change. */}
                      {protocolGroups.length > 0 && (
                        <p className="px-5 pt-3 text-xs font-medium text-fg-muted">Wallet</p>
                      )}
                      <HoldingsTable holdings={plain} walletId={walletId} />
                    </div>
                  )}
                  <HiddenByFiltersNotice
                    items={hiddenPlain.map((h) => ({ label: formatTicker(h.ticker) }))}
                    className="border-t border-border px-5 py-2 text-xs text-fg-muted"
                  />
                  {protocolGroups.map((pg) => (
                    <details
                      key={pg.protocol}
                      open
                      className="group/protocol border-t border-border first:border-t-0"
                    >
                      <summary className="flex cursor-pointer list-none items-center justify-between bg-surface-raised/40 px-5 py-2.5 [&::-webkit-details-marker]:hidden">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                          <ChevronDown
                            className="size-3.5 text-fg-muted transition-transform group-open/protocol:rotate-180"
                            aria-hidden="true"
                          />
                          <TokenIcon ticker={pg.ticker} url={pg.icon} />
                          {pg.protocol}
                          {pg.url && (
                            <StopPropagationLink href={pg.url} className="text-fg-muted transition hover:text-accent">
                              <ExternalLink className="size-3" aria-hidden="true" />
                            </StopPropagationLink>
                          )}
                        </span>
                        <span className="tabular-nums text-sm text-fg-muted">{formatUsd(pg.total)}</span>
                      </summary>
                      <div className="border-t border-border">
                        {/* One flat table unless this protocol actually uses
                            sections (only Hyperliquid does today) — every
                            other protocol's single, null-keyed group renders
                            pixel-identical to before this existed. */}
                        {groupBySection(pg.holdings).map(({ section, holdings }, i) => (
                          <div key={section ?? "_"} className={i > 0 ? "border-t border-border" : undefined}>
                            {section && (
                              <p className="px-5 pt-3 text-xs font-medium text-fg-muted">{section}</p>
                            )}
                            <HoldingsTable holdings={holdings} walletId={walletId} hideProtocolTag />
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                  <HiddenByFiltersNotice
                    items={hiddenProtocolGroups.map((pg) => ({ label: pg.protocol, total: pg.total }))}
                    className="border-t border-border px-5 py-2 text-xs text-fg-muted"
                  />
                </div>
              </details>
            );
          })}
        </div>
      )}
    </>
  );
}

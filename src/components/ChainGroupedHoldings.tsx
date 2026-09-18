import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { getChainIconMap, type ChainGroup, type HoldingWithValuation } from "@/lib/queries";
import { formatUsd, formatTicker } from "@/lib/format";
import { Panel } from "./ui/Panel";
import { HoldingsTable } from "./HoldingsTable";
import { TokenIcon } from "./TokenIcon";
import { CheckboxLink } from "./ui/CheckboxLink";
import { StopPropagationLink } from "./StopPropagationLink";

const LOW_VALUE_USD = 10;

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

function cardClass(active: boolean): string {
  const base = "rounded-lg border px-3 py-2 text-left transition";
  return active
    ? `${base} border-accent bg-surface-raised`
    : `${base} border-border bg-surface hover:border-accent/50 hover:bg-surface-raised`;
}

// baseHref may itself already carry a query string (the lookup page bakes
// `address` into it, since that has to survive every filter/chain click) —
// parsed out and merged rather than assumed empty.
function buildHref(
  baseHref: string,
  chain: string | undefined,
  hideUnpriced: boolean,
  hideLow: boolean,
): string {
  const [path, existingQs] = baseHref.split("?");
  const params = new URLSearchParams(existingQs);
  if (chain) params.set("chain", chain);
  else params.delete("chain");
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

  const visibleGroups = groups
    .filter((g) => !selectedChain || g.chainId === selectedChain)
    .map((g) => ({
      ...g,
      holdings: g.holdings.filter((h) => {
        if (h.valuation.kind === "unpriced") return !hideUnpriced;
        if (hideLow && h.valuation.usd < LOW_VALUE_USD) return false;
        return true;
      }),
    }))
    .filter((g) => g.holdings.length > 0);

  // Chains that had real holdings but ended up with none visible after the
  // hideUnpriced/hideLow filters — see the notice this drives, below.
  const hiddenGroups = groups
    .filter((g) => !selectedChain || g.chainId === selectedChain)
    .filter((g) => g.holdings.length > 0 && !visibleGroups.some((vg) => vg.chainId === g.chainId));

  return (
    <>
      <div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        <Link
          href={buildHref(baseHref, undefined, hideUnpriced, hideLow)}
          className={cardClass(!selectedChain)}
        >
          <p className="text-sm font-medium text-fg">All chains</p>
          <p className="tabular-nums text-xs text-fg-muted">{formatUsd(grandTotal)} · 100%</p>
        </Link>
        {groups.map((g) => (
          <Link
            key={g.chainId}
            href={buildHref(baseHref, g.chainId, hideUnpriced, hideLow)}
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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>{actions}</div>
        <div className="flex gap-4">
          <CheckboxLink
            href={buildHref(baseHref, selectedChain, !hideUnpriced, hideLow)}
            checked={hideUnpriced}
            label="Hide unpriced"
          />
          <CheckboxLink
            href={buildHref(baseHref, selectedChain, hideUnpriced, !hideLow)}
            checked={hideLow}
            label={`Hide low price tokens (< $${LOW_VALUE_USD})`}
          />
        </div>
      </div>

      {/* A chain's summary chip above always shows its real total (from the
          unfiltered `groups`), but its detail panel below only renders
          holdings that survive hideUnpriced/hideLow — a chain whose only
          holding(s) are individually small (e.g. a single $7.88 DeFi
          position, real and priced, just under the $10 low-value cutoff)
          would otherwise vanish from the list below with no explanation
          at all: the chip promises data, the panel shows nothing.
          Reported directly as "don't see anything" for exactly this case. */}
      {hiddenGroups.length > 0 && (
        <p className="mb-4 text-sm text-fg-muted">
          {hiddenGroups.map((g) => `${g.chainName} (${formatUsd(g.total)})`).join(", ")} hidden by the filters
          above.
        </p>
      )}

      {visibleGroups.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">Nothing to show here.</p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {visibleGroups.map((group) => {
            const { plain, protocolGroups } = groupByProtocol(group.holdings);
            // The chain-level notice above only catches a chain that
            // disappears entirely. A chain that STAYS visible (this one
            // has other, larger holdings) can still silently drop one
            // specific DeFi product whose only holding(s) were
            // individually below the low-value cutoff — e.g. a $7.88
            // Lulo position sitting right next to a $3,000+ one in the
            // same "Solana DeFi" chain. Comparing this chain's protocol
            // grouping before and after the per-holding filter catches
            // that case too.
            const rawGroup = groups.find((g) => g.chainId === group.chainId);
            const rawProtocolGroups = rawGroup ? groupByProtocol(rawGroup.holdings).protocolGroups : [];
            const visibleProtocolNames = new Set(protocolGroups.map((pg) => pg.protocol));
            const hiddenProtocolGroups = rawProtocolGroups.filter((pg) => !visibleProtocolNames.has(pg.protocol));
            // Same idea, one level further down: a plain (non-DeFi) token
            // can individually disappear from an otherwise-visible chain
            // too — a real holding with a real on-chain balance but no
            // reliable price (too illiquid to trust a quote, by design —
            // see jupiter.ts's own liquidity floor) is "unpriced", and
            // "Hide unpriced" drops it from the table with nothing to show
            // for it, same silent-vanish shape as the protocol-group case.
            const visiblePlainIds = new Set(plain.map((h) => h.id));
            const hiddenPlain = (rawGroup?.holdings.filter((h) => !h.protocol) ?? []).filter(
              (h) => !visiblePlainIds.has(h.id),
            );
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
                  <span className="tabular-nums text-fg">{formatUsd(group.total)}</span>
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
                  {hiddenPlain.length > 0 && (
                    <p className="border-t border-border px-5 py-2 text-xs text-fg-muted">
                      {hiddenPlain.map((h) => formatTicker(h.ticker)).join(", ")} hidden by the filters above.
                    </p>
                  )}
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
                        <HoldingsTable holdings={pg.holdings} walletId={walletId} hideProtocolTag />
                      </div>
                    </details>
                  ))}
                  {hiddenProtocolGroups.length > 0 && (
                    <p className="border-t border-border px-5 py-2 text-xs text-fg-muted">
                      {hiddenProtocolGroups.map((pg) => `${pg.protocol} (${formatUsd(pg.total)})`).join(", ")}{" "}
                      hidden by the filters above.
                    </p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </>
  );
}

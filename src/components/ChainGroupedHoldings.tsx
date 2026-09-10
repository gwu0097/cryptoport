import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { getChainIconMap, type ChainGroup } from "@/lib/queries";
import { formatUsd } from "@/lib/format";
import { Panel } from "./ui/Panel";
import { HoldingsTable } from "./HoldingsTable";
import { TokenIcon } from "./TokenIcon";
import { CheckboxLink } from "./ui/CheckboxLink";

const LOW_VALUE_USD = 10;

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

      {visibleGroups.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">Nothing to show here.</p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {visibleGroups.map((group) => (
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
                <HoldingsTable holdings={group.holdings} walletId={walletId} />
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

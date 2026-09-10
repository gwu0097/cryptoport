import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { ChainGroup } from "@/lib/queries";
import { formatUsd } from "@/lib/format";
import { Panel } from "./ui/Panel";
import { HoldingsTable } from "./HoldingsTable";

const MIN_USD = 5;

function cardClass(active: boolean): string {
  const base = "rounded-lg border px-3 py-2 text-left transition";
  return active
    ? `${base} border-accent bg-surface-raised`
    : `${base} border-border bg-surface hover:border-accent/50 hover:bg-surface-raised`;
}

function buildHref(baseHref: string, chain: string | undefined, hideSmall: boolean): string {
  const params = new URLSearchParams();
  if (chain) params.set("chain", chain);
  if (hideSmall) params.set("hideSmall", "1");
  const qs = params.toString();
  return qs ? `${baseHref}?${qs}` : baseHref;
}

/**
 * The $/% summary cards double as the chain filter (click a card to dive
 * into that chain, click "All chains" to go back) — one control instead of
 * a summary grid plus a separate, redundant pill row. Below that,
 * collapsible per-chain sections (native <details>/<summary>, no client JS
 * for the shell — only the table rows inside are interactive, for
 * sorting). Shared by the cross-wallet Assets page and a single auto
 * wallet's detail page, both of which have the same "one entity spans many
 * chains" shape. Read-only — a manual wallet (single-chain by definition,
 * with editable holdings) uses its own plain table instead of this
 * component.
 */
export function ChainGroupedHoldings({
  groups,
  grandTotal,
  selectedChain,
  hideSmallActive,
  baseHref,
  emptyMessage = "No holdings yet.",
}: {
  groups: ChainGroup[];
  grandTotal: number;
  selectedChain?: string;
  hideSmallActive: boolean;
  baseHref: string;
  emptyMessage?: string;
}) {
  if (groups.length === 0) {
    return (
      <Panel className="text-center">
        <p className="text-sm text-fg-muted">{emptyMessage}</p>
      </Panel>
    );
  }

  const visibleGroups = groups
    .filter((g) => !selectedChain || g.chainId === selectedChain)
    .map((g) => ({
      ...g,
      holdings: hideSmallActive
        ? g.holdings.filter((h) => h.valuation.kind === "priced" && h.valuation.usd >= MIN_USD)
        : g.holdings,
    }))
    .filter((g) => g.holdings.length > 0);

  return (
    <>
      <div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        <Link href={buildHref(baseHref, undefined, hideSmallActive)} className={cardClass(!selectedChain)}>
          <p className="text-sm font-medium text-fg">All chains</p>
          <p className="tabular-nums text-xs text-fg-muted">{formatUsd(grandTotal)} · 100%</p>
        </Link>
        {groups.map((g) => (
          <Link
            key={g.chainId}
            href={buildHref(baseHref, g.chainId, hideSmallActive)}
            className={cardClass(selectedChain === g.chainId)}
          >
            <p className="truncate text-sm font-medium text-fg">{g.chainName}</p>
            <p className="tabular-nums text-xs text-fg-muted">
              {formatUsd(g.total)}
              {grandTotal > 0 && <> · {((g.total / grandTotal) * 100).toFixed(0)}%</>}
            </p>
          </Link>
        ))}
      </div>

      <div className="mb-4 flex justify-end">
        <Link
          href={buildHref(baseHref, selectedChain, !hideSmallActive)}
          className="text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          {hideSmallActive ? "Show small/unpriced balances" : `Hide balances under $${MIN_USD}`}
        </Link>
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
                  {group.chainName}
                  <span className="text-sm font-normal text-fg-muted">
                    ({group.holdings.length} holding{group.holdings.length === 1 ? "" : "s"})
                  </span>
                </span>
                <span className="tabular-nums text-fg">{formatUsd(group.total)}</span>
              </summary>
              <div className="border-t border-border">
                <HoldingsTable holdings={group.holdings} />
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

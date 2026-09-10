import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { ChainGroup } from "@/lib/queries";
import { formatUsd } from "@/lib/format";
import { Panel } from "./ui/Panel";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "./ui/table";

const MIN_USD = 5;

function pillClass(active: boolean): string {
  const base = "rounded-full border px-3 py-1.5 text-sm transition";
  return active
    ? `${base} border-accent bg-accent text-accent-fg`
    : `${base} border-border bg-surface-raised text-fg-muted hover:text-fg`;
}

function buildHref(baseHref: string, chain: string | undefined, hideSmall: boolean): string {
  const params = new URLSearchParams();
  if (chain) params.set("chain", chain);
  if (hideSmall) params.set("hideSmall", "1");
  const qs = params.toString();
  return qs ? `${baseHref}?${qs}` : baseHref;
}

/**
 * Chain-pill filter (all chains, or dive into one — like DeBank's "All
 * Chain" dropdown, minus the dropdown) plus collapsible per-chain sections
 * (native <details>/<summary>, no client JS) — deliberately not DeBank's
 * flat list with the chain labeled next to each token. Shared by the
 * cross-wallet Assets page and a single auto wallet's detail page, both of
 * which have the same "one entity spans many chains" shape. Read-only — a
 * manual wallet (single-chain by definition, with editable holdings) uses
 * its own plain table instead, not this component.
 */
export function ChainGroupedHoldings({
  groups,
  selectedChain,
  hideSmallActive,
  baseHref,
  emptyMessage = "No holdings yet.",
}: {
  groups: ChainGroup[];
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
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={buildHref(baseHref, undefined, hideSmallActive)} className={pillClass(!selectedChain)}>
          All chains
        </Link>
        {groups.map((g) => (
          <Link
            key={g.chainId}
            href={buildHref(baseHref, g.chainId, hideSmallActive)}
            className={pillClass(selectedChain === g.chainId)}
          >
            {g.chainName}
          </Link>
        ))}
        <Link
          href={buildHref(baseHref, selectedChain, !hideSmallActive)}
          className="ml-auto text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline"
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
                <table className={tableClass}>
                  <thead>
                    <tr className={theadRowClass}>
                      <th className={thClass}>Ticker</th>
                      <th className={thClass}>Qty</th>
                      <th className={thClass}>Price</th>
                      <th className={thClass}>Value</th>
                      <th className={thClass}>Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.holdings.map((holding) => (
                      <tr key={holding.id} className={trClass}>
                        <td className={tdClass}>{holding.ticker}</td>
                        <td className={`${tdClass} tabular-nums`}>{holding.qty ?? "—"}</td>
                        <td className={`${tdClass} tabular-nums`}>{holding.price ?? "unpriced"}</td>
                        <td className={`${tdClass} tabular-nums`}>
                          {holding.valuation.kind === "priced" ? (
                            formatUsd(holding.valuation.usd)
                          ) : (
                            <span className="text-warning">unpriced</span>
                          )}
                        </td>
                        <td className={tdClass}>
                          <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                            {holding.category}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

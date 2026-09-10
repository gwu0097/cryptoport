import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { ChainGroup } from "@/lib/queries";
import { formatUsd } from "@/lib/format";
import { Panel } from "./ui/Panel";
import { HoldingsTable } from "./HoldingsTable";

const MIN_USD = 5;
const TOP_N_CHAINS = 10;

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
 * Chain-pill filter (top 10 by value directly, the rest behind a "More
 * chains" dropdown that also shows each one's $ — like DeBank's chain
 * switcher) plus a $/％ summary grid and collapsible per-chain sections
 * (native <details>/<summary>, no client JS for the shell — only the table
 * rows inside are interactive, for sorting). Shared by the cross-wallet
 * Assets page and a single auto wallet's detail page, both of which have
 * the same "one entity spans many chains" shape. Read-only — a manual
 * wallet (single-chain by definition, with editable holdings) uses its own
 * plain table instead of this component.
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

  const topGroups = groups.slice(0, TOP_N_CHAINS);
  const restGroups = groups.slice(TOP_N_CHAINS);
  const restSelected = restGroups.some((g) => g.chainId === selectedChain);

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
      {!selectedChain && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
          {groups.map((g) => (
            <div key={g.chainId} className="rounded-lg border border-border bg-surface px-3 py-2">
              <p className="truncate text-sm font-medium text-fg">{g.chainName}</p>
              <p className="tabular-nums text-xs text-fg-muted">
                {formatUsd(g.total)}
                {grandTotal > 0 && <> · {((g.total / grandTotal) * 100).toFixed(0)}%</>}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={buildHref(baseHref, undefined, hideSmallActive)} className={pillClass(!selectedChain)}>
          All chains
        </Link>
        {topGroups.map((g) => (
          <Link
            key={g.chainId}
            href={buildHref(baseHref, g.chainId, hideSmallActive)}
            className={pillClass(selectedChain === g.chainId)}
          >
            {g.chainName}
          </Link>
        ))}
        {restGroups.length > 0 && (
          <details className="group/more relative">
            <summary
              className={`${pillClass(restSelected)} inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden`}
            >
              More chains ({restGroups.length})
              <ChevronDown className="size-3.5 transition-transform group-open/more:rotate-180" aria-hidden="true" />
            </summary>
            <div className="absolute z-10 mt-2 flex w-56 flex-col gap-0.5 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
              {restGroups.map((g) => (
                <Link
                  key={g.chainId}
                  href={buildHref(baseHref, g.chainId, hideSmallActive)}
                  className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm ${
                    selectedChain === g.chainId ? "bg-surface-raised text-fg" : "text-fg-muted hover:bg-surface-raised hover:text-fg"
                  }`}
                >
                  <span>{g.chainName}</span>
                  <span className="tabular-nums">{formatUsd(g.total)}</span>
                </Link>
              ))}
            </div>
          </details>
        )}
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
                <HoldingsTable holdings={group.holdings} />
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

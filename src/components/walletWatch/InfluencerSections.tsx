import Link from "next/link";
import type { ReactNode } from "react";
import { isInProgressStatus } from "@/lib/jobStatus";
import { ExternalLink, Search } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import type { InfluencerDetail, WatchedInfluencer, WatchMovementView } from "@/lib/watchQuery";
import { externalPortfolioViewer } from "@/lib/walletDisplay";
import { formatUsd } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { AgeText } from "@/components/AgeText";
import { ValueChart } from "@/components/charts/ValueChart";
import { ShareLinkButton } from "@/components/ShareLinkButton";
import { ActivityFeed } from "@/components/walletWatch/ActivityFeed";
import { CheckboxLink } from "@/components/ui/CheckboxLink";

// An influencer's page body — value, chart, activity, addresses, holdings —
// shared by the owner's page (/wallet-watch/[id]) and a shared link
// (/wallet-watch/shared/[token]). The owner's page adds its own controls
// through the slots.

export const lookupPath = (address: string) => `/lookup?address=${encodeURIComponent(address)}`;

/** The same view with "merge same coin" flipped, other filters kept. */
function mergeToggleHref(baseHref: string, filters: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const k of ["chain", "protocol", "hideUnpriced", "hideLow"]) if (filters[k]) q.set(k, filters[k]!);
  if (filters.merge !== "1") q.set("merge", "1");
  const s = q.toString();
  return s ? `${baseHref}?${s}` : baseHref;
}

export function InfluencerTitle({ influencer }: { influencer: WatchedInfluencer }) {
  return (
    <span className="flex items-center gap-2">
      {influencer.name}
      {influencer.link && (
        <a href={influencer.link} target="_blank" rel="noopener noreferrer" aria-label="Profile" className="text-fg-muted hover:text-fg">
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      )}
    </span>
  );
}

export function InfluencerSections({
  influencer,
  holdings,
  notListed,
  filters,
  movements,
  daily,
  serverNowSec,
  baseHref,
  valueExtra,
  afterValue,
  activityTop,
  addressExtra,
  addressesFooter,
}: {
  influencer: WatchedInfluencer;
  holdings: InfluencerDetail["holdings"];
  notListed: InfluencerDetail["notListed"];
  /** The holdings filters from this page's URL (as on Portfolio). */
  filters: { chain?: string; protocol?: string; hideUnpriced?: string; hideLow?: string; merge?: string };
  movements: WatchMovementView[];
  daily: { date: string; total: number }[];
  serverNowSec: number;
  /** This page's own URL, for the holdings filters. */
  baseHref: string;
  valueExtra?: ReactNode;
  /** A section between the value card and the chart (the trading record). */
  afterValue?: ReactNode;
  /** Above the Activity feed: today's activity check (owner's page only). */
  activityTop?: ReactNode;
  /** Per-address controls (the owner's remove button). */
  addressExtra?: (address: WatchedInfluencer["addresses"][number]) => ReactNode;
  addressesFooter?: ReactNode;
}) {
  return (
    <>
      <Panel className="mb-4">
        <p className="text-3xl font-semibold tabular-nums text-fg">{influencer.valueUsd === null ? "—" : formatUsd(influencer.valueUsd)}</p>
        <p className="mt-1 text-xs text-fg-muted">
          Last read at today&apos;s prices{influencer.unpricedCount > 0 ? ` · ${influencer.unpricedCount} holdings unpriced or illiquid, not counted` : ""}.
        </p>
        {valueExtra && <div className="mt-4">{valueExtra}</div>}
      </Panel>

      {afterValue}
      <Panel title="Value over time" className="mb-4">
        {daily.length < 2 ? (
          <p className="text-sm text-fg-muted">The chart fills in as the wallet is read each day ({daily.length} day{daily.length === 1 ? "" : "s"} so far).</p>
        ) : (
          <ValueChart points={daily.map((d) => ({ ...d, kind: "real" as const }))} rangeStorageKey="cryptoport:watchValueRange" />
        )}
      </Panel>

      <Panel title="Activity" description="Changes between reads, sized at that read's price." className="mb-4">
        {activityTop}
        <ActivityFeed movements={movements} serverNowSec={serverNowSec} showNames={false} showWallet={influencer.addresses.length > 1} />
      </Panel>

      <Panel
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            Addresses
            {influencer.addresses.length > 0 && (
              <ShareLinkButton
                paths={influencer.addresses.map((a) => lookupPath(a.address))}
                label={influencer.addresses.length > 1 ? `Copy ${influencer.addresses.length} lookup links` : "Copy lookup link"}
              />
            )}
          </span>
        }
        description="Lookup links open the address on CryptoPort for anyone — no account needed."
        className="mb-4"
      >
        <ul className="space-y-2">
          {influencer.addresses.map((a) => {
            const viewer = externalPortfolioViewer(a.chain, a.address);
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs text-fg-muted">{a.chain}</span>
                <span className="break-all font-mono text-xs text-fg">{a.address}</span>
                <CopyButton value={a.address} label="Copy address" title={`Copy the address: ${a.address}`} />
                {viewer && (
                  <a href={viewer.url} target="_blank" rel="noopener noreferrer" title={`View on ${viewer.label}`} className="text-fg-muted hover:text-fg">
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                )}
                <Link href={lookupPath(a.address)} title="Open in CryptoPort lookup" aria-label="Open in CryptoPort lookup" className="text-fg-muted hover:text-fg">
                  <Search className="size-3.5" aria-hidden="true" />
                </Link>
                <ShareLinkButton compact paths={[lookupPath(a.address)]} label="Copy lookup link" />
                <span className="tabular-nums text-fg-muted">{a.valueUsd === null ? "—" : formatUsd(a.valueUsd)}</span>
                <span className="text-xs text-fg-muted">
                  {isInProgressStatus(a.refreshStatus) ? "reading now…" : <AgeText at={a.lastRefreshAt} serverNowSec={serverNowSec} prefix="read " />}
                </span>
                {a.lastRefreshStatus && a.lastRefreshStatus !== "ok" && !isInProgressStatus(a.refreshStatus) && (
                  <span className={`text-xs ${a.lastRefreshStatus.startsWith("error:") ? "text-negative" : "text-warning"}`} title={a.lastRefreshStatus}>
                    {a.lastRefreshStatus.startsWith("error:") ? "last read failed" : "partly read"}
                  </span>
                )}
                {addressExtra?.(a)}
              </li>
            );
          })}
        </ul>
        {addressesFooter && <div className="mt-4">{addressesFooter}</div>}
      </Panel>

      <h2 className="mb-2 text-sm font-medium text-fg-muted">
        Holdings across {influencer.addresses.length === 1 ? "its address" : `all ${influencer.addresses.length} addresses`}
        {(notListed.unrecognizedCount > 0 || notListed.dustCount > 0) && (
          <span className="ml-2 text-xs">
            (not listed:
            {notListed.dustCount > 0 && ` ${notListed.dustCount} holdings under $1${notListed.dustUsd === null ? "" : `, about ${formatUsd(notListed.dustUsd)} together at the last read`}`}
            {notListed.dustCount > 0 && notListed.unrecognizedCount > 0 && ";"}
            {notListed.unrecognizedCount > 0 && ` ${notListed.unrecognizedCount} unrecognized or spam tokens`})
          </span>
        )}
      </h2>
      {holdings ? (
        <ChainGroupedHoldings
          actions={<CheckboxLink href={mergeToggleHref(baseHref, filters)} checked={filters.merge === "1"} label="Merge same coin across addresses" />}
          groups={holdings.chainGroups}
          grandTotal={holdings.total}
          selectedChain={filters.chain}
          selectedProtocol={filters.protocol}
          hideUnpriced={filters.hideUnpriced !== "0"}
          hideLow={filters.hideLow !== "0"}
          baseHref={filters.merge === "1" ? `${baseHref}?merge=1` : baseHref}
          emptyMessage="Nothing held at the last read."
        />
      ) : (
        <Panel>
          <p className="text-sm text-fg-muted">{influencer.addresses.some((a) => isInProgressStatus(a.refreshStatus)) ? "Reading these addresses…" : "Not read yet."}</p>
        </Panel>
      )}
    </>
  );
}

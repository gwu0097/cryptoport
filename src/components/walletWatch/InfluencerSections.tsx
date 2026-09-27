import Link from "next/link";
import type { ReactNode } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { InfluencerDetail, WatchedInfluencer, WatchMovementView } from "@/lib/watchQuery";
import { externalPortfolioViewer } from "@/lib/walletDisplay";
import { formatUsd } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { AgeText } from "@/components/AgeText";
import { ValueChart } from "@/components/charts/ValueChart";
import { ShareLinkButton } from "@/components/ShareLinkButton";
import { ActivityFeed } from "@/components/walletWatch/ActivityFeed";

// An influencer's page body — value, chart, activity, addresses, holdings —
// shared by the owner's page (/wallet-watch/[id]) and a shared link
// (/wallet-watch/shared/[token]). The owner's page adds its own controls
// through the slots.

export const lookupPath = (address: string) => `/lookup?address=${encodeURIComponent(address)}`;

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
  movements,
  daily,
  serverNowSec,
  baseHref,
  valueExtra,
  addressExtra,
  addressesFooter,
}: {
  influencer: WatchedInfluencer;
  holdings: InfluencerDetail["holdings"];
  movements: WatchMovementView[];
  daily: { date: string; total: number }[];
  serverNowSec: number;
  /** This page's own URL, for the holdings filters. */
  baseHref: string;
  valueExtra?: ReactNode;
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

      <Panel title="Value over time" className="mb-4">
        {daily.length < 2 ? (
          <p className="text-sm text-fg-muted">The chart fills in as the wallet is read each day ({daily.length} day{daily.length === 1 ? "" : "s"} so far).</p>
        ) : (
          <ValueChart points={daily.map((d) => ({ ...d, kind: "real" as const }))} rangeStorageKey="cryptoport:watchValueRange" />
        )}
      </Panel>

      <Panel title="Activity" description="Changes between reads, sized at that read's price." className="mb-4">
        <ActivityFeed movements={movements} serverNowSec={serverNowSec} showNames={false} />
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
                  {a.refreshStatus === "syncing" ? "reading now…" : <AgeText at={a.lastRefreshAt} serverNowSec={serverNowSec} prefix="read " />}
                </span>
                {a.lastRefreshStatus && a.lastRefreshStatus !== "ok" && a.refreshStatus !== "syncing" && (
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

      {holdings.map(({ address, valuated, unrecognizedCount, dust }) => (
        <section key={address.id} className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-fg-muted">
            Holdings · <span className="font-mono">{address.address.slice(0, 6)}…{address.address.slice(-4)}</span>
            {(unrecognizedCount > 0 || dust.count > 0) && (
              <span className="ml-2 text-xs">
                (not listed:{dust.count > 0 && ` ${dust.count} holdings under $1${dust.usd === null ? "" : `, about ${formatUsd(dust.usd)} together at the last read`}`}
                {dust.count > 0 && unrecognizedCount > 0 && ";"}
                {unrecognizedCount > 0 && ` ${unrecognizedCount} unrecognized or spam tokens`})
              </span>
            )}
          </h2>
          {valuated ? (
            <ChainGroupedHoldings groups={valuated.chainGroups} grandTotal={valuated.total} hideUnpriced hideLow baseHref={baseHref} emptyMessage="Nothing held at the last read." />
          ) : (
            <Panel>
              <p className="text-sm text-fg-muted">{address.refreshStatus === "syncing" ? "Reading this address…" : "Not read yet."}</p>
            </Panel>
          )}
        </section>
      ))}
    </>
  );
}

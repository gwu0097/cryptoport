import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getUser } from "@/lib/auth";
import { getInfluencerDailyValue, getInfluencerDetail, getWatchMovements, watchJobStatus } from "@/lib/watchQuery";
import { ActivityFeed } from "@/components/walletWatch/ActivityFeed";
import { ValueChart } from "@/components/charts/ValueChart";
import { requestNowSec } from "@/lib/requestClock";
import { externalPortfolioViewer } from "@/lib/walletDisplay";
import { formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SignInPrompt } from "@/components/SignInPrompt";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";
import { AgeText } from "@/components/AgeText";
import { InfluencerEditor, RemoveAddressButton } from "@/components/walletWatch/InfluencerEditor";
import { WatchAddressForm } from "@/components/walletWatch/WatchAddressForm";
import { RefreshWatchButton } from "@/components/walletWatch/RefreshWatchButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet Watch · CryptoPort" };
export const maxDuration = 300;

export default async function InfluencerPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await getUser())) return <SignInPrompt message="Log in to see the wallets you watch." />;
  const { id } = await params;
  const detail = await getInfluencerDetail(id);
  if (!detail) notFound();
  const { influencer, groups, holdings } = detail;
  const nowSec = requestNowSec();
  const [movements, daily] = await Promise.all([getWatchMovements([influencer]), getInfluencerDailyValue(influencer)]);

  return (
    <>
      <Link href="/wallet-watch" className="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden="true" /> Wallet Watch
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {influencer.name}
            {influencer.link && (
              <a href={influencer.link} target="_blank" rel="noopener noreferrer" aria-label="Profile" className="text-fg-muted hover:text-fg">
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            )}
          </span>
        }
        subtitle={influencer.note ?? undefined}
        actions={<RefreshWatchButton influencerIds={[influencer.id]} status={watchJobStatus(influencer.addresses, nowSec * 1000)} />}
      />

      <Panel className="mb-4">
        <p className="text-3xl font-semibold tabular-nums text-fg">{influencer.valueUsd === null ? "—" : formatUsd(influencer.valueUsd)}</p>
        <p className="mt-1 text-xs text-fg-muted">
          Last read at today&apos;s prices{influencer.unpricedCount > 0 ? ` · ${influencer.unpricedCount} holdings have no price and aren't counted` : ""}.
        </p>
        <div className="mt-4">
          <InfluencerEditor influencer={influencer} groups={groups} />
        </div>
      </Panel>

      <Panel title="Value over time" className="mb-4">
        {daily.length < 2 ? (
          <p className="text-sm text-fg-muted">The chart fills in as the wallet is read each day ({daily.length} day{daily.length === 1 ? "" : "s"} so far).</p>
        ) : (
          <ValueChart points={daily.map((d) => ({ ...d, kind: "real" as const }))} rangeStorageKey="cryptoport:watchValueRange" />
        )}
      </Panel>

      <Panel title="Activity" description="Changes between reads, sized at that read's price." className="mb-4">
        <ActivityFeed movements={movements} serverNowSec={nowSec} showNames={false} />
      </Panel>

      <Panel title="Addresses" className="mb-4">
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
                <span className="tabular-nums text-fg-muted">{a.valueUsd === null ? "—" : formatUsd(a.valueUsd)}</span>
                <span className="text-xs text-fg-muted">
                  {a.refreshStatus === "syncing" ? "reading now…" : <AgeText at={a.lastRefreshAt} serverNowSec={nowSec} prefix="read " />}
                </span>
                {a.lastRefreshStatus && a.lastRefreshStatus !== "ok" && a.refreshStatus !== "syncing" && (
                  <span className={`text-xs ${a.lastRefreshStatus.startsWith("error:") ? "text-negative" : "text-warning"}`} title={a.lastRefreshStatus}>
                    {a.lastRefreshStatus.startsWith("error:") ? "last read failed" : "partly read"}
                  </span>
                )}
                <RemoveAddressButton addressId={a.id} influencerId={influencer.id} address={a.address} />
              </li>
            );
          })}
        </ul>
        {influencer.addresses.length < 5 && (
          <div className="mt-4">
            <WatchAddressForm options={{ influencers: [], groups: [] }} influencerId={influencer.id} label="Add another address" />
          </div>
        )}
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
            <ChainGroupedHoldings
              groups={valuated.chainGroups}
              grandTotal={valuated.total}
              hideUnpriced
              hideLow
              baseHref={`/wallet-watch/${influencer.id}`}
              emptyMessage="Nothing held at the last read."
            />
          ) : (
            <Panel>
              <p className="text-sm text-fg-muted">{address.refreshStatus === "syncing" ? "Reading this address…" : "Not read yet — press Refresh."}</p>
            </Panel>
          )}
        </section>
      ))}
    </>
  );
}

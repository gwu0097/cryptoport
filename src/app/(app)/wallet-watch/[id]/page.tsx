import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getUser } from "@/lib/auth";
import { getInfluencerDailyValue, getInfluencerDetail, getLiveStatus, getTradingRecord, getWatchDayActivity, getWatchedInfluencer, getWatchMovements, watchJobStatus } from "@/lib/watchQuery";
import { isAdminEmail } from "@/lib/adminAuth";
import { LiveToggle } from "@/components/walletWatch/LiveToggle";
import { requestNowSec } from "@/lib/requestClock";
import { PageHeader } from "@/components/PageHeader";
import { SignInPrompt } from "@/components/SignInPrompt";
import { InfluencerEditor, RemoveAddressButton } from "@/components/walletWatch/InfluencerEditor";
import { WatchAddressForm } from "@/components/walletWatch/WatchAddressForm";
import { RefreshWatchButton } from "@/components/walletWatch/RefreshWatchButton";
import { ShareInfluencerButton } from "@/components/walletWatch/ShareInfluencerButton";
import { InfluencerSections, InfluencerTitle } from "@/components/walletWatch/InfluencerSections";
import { TradingRecordPanel } from "@/components/walletWatch/TradingRecordPanel";
import { DayActivity } from "@/components/walletWatch/DayActivity";
import { RecordRecentWallet } from "@/components/RecordRecentWallet";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet Watch · CryptoPort" };
export const maxDuration = 300;

export default async function InfluencerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ chain?: string; protocol?: string; hideUnpriced?: string; hideLow?: string; merge?: string }> }) {
  const user = await getUser();
  if (!user) return <SignInPrompt message="Log in to see the wallets you watch." />;
  const isOwner = isAdminEmail(user.email, process.env.ADMIN_EMAIL);
  const { id } = await params;
  const filters = await searchParams;
  // The influencer's own rows first (small), then everything else at once —
  // holdings are valued while the activity, history and records load.
  const watched = await getWatchedInfluencer(id);
  if (!watched) notFound();
  const nowSec = requestNowSec();
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const [detail, movements, daily, record, day, live] = await Promise.all([
    getInfluencerDetail(id, filters.merge === "1"),
    getWatchMovements([watched.influencer]),
    getInfluencerDailyValue(watched.influencer),
    getTradingRecord(watched.influencer, today),
    getWatchDayActivity([watched.influencer]),
    isOwner ? getLiveStatus(watched.influencer) : null,
  ]);
  if (!detail) notFound();
  const { influencer, groups, holdings, notListed } = detail;

  return (
    <>
      {/* Its sidebar's "recently viewed" list (the last 4, like Wallets). */}
      <RecordRecentWallet id={influencer.id} name={influencer.name} namespace="walletWatch" />
      <Link href="/wallet-watch" className="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden="true" /> Wallet Watch
      </Link>
      <PageHeader
        title={<InfluencerTitle influencer={influencer} />}
        subtitle={influencer.note ?? undefined}
        actions={
          <span className="flex flex-wrap items-start justify-end gap-2">
            <ShareInfluencerButton influencerId={influencer.id} shareToken={influencer.shareToken} />
            <RefreshWatchButton influencerIds={[influencer.id]} status={watchJobStatus(influencer.addresses, nowSec * 1000)} />
          </span>
        }
      />
      <InfluencerSections
        influencer={influencer}
        holdings={holdings}
        notListed={notListed}
        filters={filters}
        movements={movements}
        daily={daily}
        serverNowSec={nowSec}
        baseHref={`/wallet-watch/${influencer.id}`}
        valueExtra={
          <>
            <InfluencerEditor influencer={influencer} groups={groups} />
            {live && live.solana > 0 && <LiveToggle influencerId={influencer.id} live={live.live} liveSince={live.liveSince} lastEventAt={live.lastEventAt} serverNowSec={nowSec} />}
          </>
        }
        activityTop={
          <DayActivity
            coins={day.coins}
            checkedAt={day.checkedAt[influencer.id] ?? null}
            issues={day.issues}
            liveIds={day.liveIds}
            influencerIds={[influencer.id]}
            serverNowSec={nowSec}
            showNames={false}
          />
        }
        afterValue={<TradingRecordPanel influencerId={influencer.id} {...record} today={today} serverNowSec={nowSec} />}
        addressExtra={(a) => <RemoveAddressButton addressId={a.id} influencerId={influencer.id} address={a.address} />}
        addressesFooter={
          influencer.addresses.length < 5 ? <WatchAddressForm options={{ influencers: [], groups: [] }} influencerId={influencer.id} label="Add another address" /> : undefined
        }
      />
    </>
  );
}

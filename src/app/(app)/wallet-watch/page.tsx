import { Suspense } from "react";
import { cookies } from "next/headers";
import { isAdminEmail } from "@/lib/adminAuth";
import { WATCH_GROUP_COOKIE } from "@/lib/watchGroupCookie";
import { scopePricesToUser } from "@/lib/queries";
import { getUser } from "@/lib/auth";
import { getWatchDayActivity, getWatchMovements, getWatchOverview, watchJobStatus } from "@/lib/watchQuery";
import { ActivityFeed } from "@/components/walletWatch/ActivityFeed";
import { DayActivity } from "@/components/walletWatch/DayActivity";
import { requestNowSec } from "@/lib/requestClock";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { GroupTabs } from "@/components/walletWatch/GroupTabs";
import { WatchTable } from "@/components/walletWatch/WatchTable";
import { WatchAddressForm } from "@/components/walletWatch/WatchAddressForm";
import { RefreshWatchButton } from "@/components/walletWatch/RefreshWatchButton";
import { WalletSearch } from "@/components/walletWatch/WalletSearch";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet Watch · CryptoPort" };
// A refresh reads wallets inside after(), which shares this route's budget.
export const maxDuration = 300;

const SUBTITLE = "Follow other people's wallets — influencers, funds, smart money — and group them by why you follow them";

export default async function WalletWatchPage({ searchParams }: { searchParams: Promise<{ group?: string; searchError?: string }> }) {
  scopePricesToUser(true); // the user's own coins and the Wallet Watch coins they see (docs/perf/PRICES_READ.md)
  const user = await getUser();
  if (!user) {
    return (
      <>
        <PageHeader title="Wallet Watch" subtitle={SUBTITLE} />
        <GuestBanner message="Sign up or connect a wallet to follow other wallets here." />
        <Panel>
          <p className="text-sm text-fg-muted">Log in to watch influencers&apos; wallets here.</p>
        </Panel>
      </>
    );
  }
  const { group: asked, searchError } = await searchParams;
  // No group in the link (the sidebar, a back link): the last one picked
  // (owner 2026-09-30); "all" is an explicit All.
  const remembered = (await cookies()).get(WATCH_GROUP_COOKIE)?.value;
  const group = (asked ?? remembered) === "all" ? undefined : (asked ?? remembered);
  const isOwner = isAdminEmail(user.email, process.env.ADMIN_EMAIL);
  return (
    <Suspense key={group ?? "all"} fallback={<Panel><p className="text-sm text-fg-muted">Loading…</p></Panel>}>
      <WalletWatchContent groupId={group} searchError={searchError} isOwner={isOwner} />
    </Suspense>
  );
}

async function WalletWatchContent({ groupId, searchError, isOwner }: { groupId?: string; searchError?: string; isOwner: boolean }) {
  const { groups, influencers, searched } = await getWatchOverview();
  const nowSec = requestNowSec();
  const selected = groups.find((g) => g.id === groupId) ?? null;
  const shown = selected ? influencers.filter((i) => i.groupIds.includes(selected.id)) : influencers;
  const counts = Object.fromEntries(groups.map((g) => [g.id, influencers.filter((i) => i.groupIds.includes(g.id)).length])) as Record<string, number>;
  // Only your own influencers take a new address (a shared group's belong to their creators).
  const options = { influencers: influencers.filter((i) => i.mine).map((i) => ({ id: i.id, name: i.name })), groups };
  const [movements, day] = await Promise.all([getWatchMovements(shown, 50), getWatchDayActivity(shown)]);

  return (
    <>
      <PageHeader
        title="Wallet Watch"
        subtitle={SUBTITLE}
        actions={
          <span className="flex flex-wrap items-start justify-end gap-2">
            <WalletSearch searched={searched} error={searchError} />
            <RefreshWatchButton
              influencerIds={shown.map((i) => i.id)}
              status={watchJobStatus(shown.flatMap((i) => i.addresses), nowSec * 1000)}
              label={selected ? `Refresh ${selected.name}` : "Refresh all"}
            />
          </span>
        }
      />
      <GroupTabs groups={groups} selected={selected} counts={{ ...counts, all: influencers.length }} />
      <Panel className="mb-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-2xl text-sm text-fg-muted">
            Values are each wallet&apos;s last read at today&apos;s prices. Every watched wallet is read once a day, and when you add it or
            press Refresh.
          </p>
          <WatchAddressForm options={options} />
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {selected
              ? `No one in "${selected.name}" yet — add a wallet and tick this group, or add existing influencers from their page.`
              : "No wallets watched yet. Add one here, or use “Watch this wallet” after searching an address in the top bar."}
          </p>
        ) : (
          <WatchTable influencers={shown} groups={groups} serverNowSec={nowSec} isOwner={isOwner} />
        )}
      </Panel>
      <Panel
        title={selected ? `Activity · ${selected.name}` : "Activity"}
        description="What they bought and sold between reads — sized at that read's price. A buy and sell between two reads doesn't show; changes under $100, or under 1% of a position and $5,000, are left out."
        className="mb-4"
      >
        <DayActivity
          coins={day.coins}
          checkedAt={Object.values(day.checkedAt).sort().at(-1) ?? null}
          issues={day.issues}
          liveIds={day.liveIds}
          influencerIds={shown.map((i) => i.id)}
          serverNowSec={nowSec}
        />
        <ActivityFeed movements={movements} serverNowSec={nowSec} />
      </Panel>
      <p className="text-xs text-fg-muted">Up to 40 influencers, 5 addresses each. DeFi positions aren&apos;t read for watched wallets.</p>
    </>
  );
}

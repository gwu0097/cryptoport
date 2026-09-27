import { Suspense } from "react";
import { getUser } from "@/lib/auth";
import { getWatchMovements, getWatchOverview, watchJobStatus } from "@/lib/watchQuery";
import { ActivityFeed } from "@/components/walletWatch/ActivityFeed";
import { requestNowSec } from "@/lib/requestClock";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { GroupTabs } from "@/components/walletWatch/GroupTabs";
import { WatchTable } from "@/components/walletWatch/WatchTable";
import { WatchAddressForm } from "@/components/walletWatch/WatchAddressForm";
import { RefreshWatchButton } from "@/components/walletWatch/RefreshWatchButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet Watch · CryptoPort" };
// A refresh reads wallets inside after(), which shares this route's budget.
export const maxDuration = 300;

const SUBTITLE = "Follow other people's wallets — influencers, funds, smart money — and group them by why you follow them";

export default async function WalletWatchPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
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
  const { group } = await searchParams;
  return (
    <Suspense key={group ?? "all"} fallback={<Panel><p className="text-sm text-fg-muted">Loading…</p></Panel>}>
      <WalletWatchContent groupId={group} />
    </Suspense>
  );
}

async function WalletWatchContent({ groupId }: { groupId?: string }) {
  const { groups, influencers } = await getWatchOverview();
  const nowSec = requestNowSec();
  const selected = groups.find((g) => g.id === groupId) ?? null;
  const shown = selected ? influencers.filter((i) => i.groupIds.includes(selected.id)) : influencers;
  const counts = Object.fromEntries(groups.map((g) => [g.id, influencers.filter((i) => i.groupIds.includes(g.id)).length])) as Record<string, number>;
  const options = { influencers: influencers.map((i) => ({ id: i.id, name: i.name })), groups };
  const movements = await getWatchMovements(shown, 50);

  return (
    <>
      <PageHeader
        title="Wallet Watch"
        subtitle={SUBTITLE}
        actions={
          <RefreshWatchButton
            influencerIds={shown.map((i) => i.id)}
            status={watchJobStatus(shown.flatMap((i) => i.addresses), nowSec * 1000)}
            label={selected ? `Refresh ${selected.name}` : "Refresh all"}
          />
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
          <WatchTable influencers={shown} groups={groups} serverNowSec={nowSec} />
        )}
      </Panel>
      <Panel
        title={selected ? `Activity · ${selected.name}` : "Activity"}
        description="What they bought and sold between reads — sized at that read's price. A buy and sell between two reads doesn't show; changes under $100 or 5% of a position are left out."
        className="mb-4"
      >
        <ActivityFeed movements={movements} serverNowSec={nowSec} />
      </Panel>
      <p className="text-xs text-fg-muted">Up to 25 influencers, 5 addresses each. DeFi positions aren&apos;t read for watched wallets.</p>
    </>
  );
}

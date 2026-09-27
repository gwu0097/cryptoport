import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { getUser } from "@/lib/auth";
import { getSharedInfluencer, getWatchOverview } from "@/lib/watchQuery";
import { requestNowSec } from "@/lib/requestClock";
import { PageHeader } from "@/components/PageHeader";
import { SignInPrompt } from "@/components/SignInPrompt";
import { InfluencerSections, InfluencerTitle } from "@/components/walletWatch/InfluencerSections";
import { AddSharedButton } from "@/components/walletWatch/AddSharedButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared wallet · CryptoPort" };

/**
 * An influencer another user shared (docs/wallet-watch/PLAN.md): read-only
 * for any signed-in user, without adding it to their list. The sharer's note
 * and groups aren't shown. A revoked or unknown link is a 404.
 */
export default async function SharedInfluencerPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ chain?: string; protocol?: string; hideUnpriced?: string; hideLow?: string; merge?: string }> }) {
  if (!(await getUser())) return <SignInPrompt message="Log in to see this shared wallet." />;
  const { token } = await params;
  const filters = await searchParams;
  const shared = await getSharedInfluencer(token, filters.merge === "1");
  if (!shared) notFound();
  const { influencer, holdings, notListed, movements, daily } = shared;
  // Already watching every one of these addresses? Say where, instead of offering a copy.
  const mine = (await getWatchOverview()).influencers.find((i) => influencer.addresses.every((a) => i.addresses.some((b) => b.address === a.address)));

  return (
    <>
      <PageHeader
        title={<InfluencerTitle influencer={influencer} />}
        subtitle="Shared with you on CryptoPort — read-only"
        actions={
          mine ? (
            <Link href={`/wallet-watch/${mine.id}`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
              <Eye className="size-3.5" aria-hidden="true" /> In your Wallet Watch as {mine.name}
            </Link>
          ) : (
            <AddSharedButton token={token} />
          )
        }
      />
      <InfluencerSections
        influencer={influencer}
        holdings={holdings}
        notListed={notListed}
        filters={filters}
        movements={movements}
        daily={daily}
        serverNowSec={requestNowSec()}
        baseHref={`/wallet-watch/shared/${token}`}
      />
    </>
  );
}

import Link from "next/link";
import { getChainIconMap } from "@/lib/queries";
import { ExternalLink, Eye } from "lucide-react";
import { getUser } from "@/lib/auth";
import { getWatchFeedTargets } from "@/lib/watchQuery";
import { normalizeWatchAddress } from "@/lib/watchSnapshot";
import { WatchAddressForm } from "@/components/walletWatch/WatchAddressForm";
import { ShareLinkButton } from "@/components/ShareLinkButton";
import { lookupWallet } from "@/lib/lookup";
import { externalPortfolioViewer } from "@/lib/walletDisplay";
import { formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ChainGroupedHoldings } from "@/components/ChainGroupedHoldings";

export const dynamic = "force-dynamic";
// Same reasoning as the per-wallet sync (wallets/[id]/page.tsx) — this hits
// the identical on-chain adapters, just for an address with no wallet row.
export const maxDuration = 300;
export const metadata = { title: "Wallet lookup · CryptoPort" };

export default async function LookupPage({
  searchParams,
}: {
  searchParams: Promise<{
    address?: string;
    chain?: string;
    protocol?: string;
    hideUnpriced?: string;
    hideLow?: string;
  }>;
}) {
  const { address, chain: selectedChain, protocol: selectedProtocol, hideUnpriced, hideLow } = await searchParams;

  return (
    <>
      <PageHeader
        title="Wallet lookup"
        subtitle="Search any ETH, SOL, BTC, or ADA address — read-only, nothing is saved to your portfolio. Lookup links open for anyone, no account needed."
      />

      {!address ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">
            Use the search bar at the top to look up a wallet address.
          </p>
        </Panel>
      ) : (
        <LookupResults
          address={address}
          selectedChain={selectedChain}
          selectedProtocol={selectedProtocol}
          hideUnpriced={hideUnpriced !== "0"}
          hideLow={hideLow !== "0"}
        />
      )}
    </>
  );
}

async function LookupResults({
  address,
  selectedChain,
  selectedProtocol,
  hideUnpriced,
  hideLow,
}: {
  address: string;
  selectedChain?: string;
  selectedProtocol?: string;
  hideUnpriced: boolean;
  hideLow: boolean;
}) {
  let result;
  try {
    result = await lookupWallet(address);
  } catch (e) {
    return (
      <Panel className="text-center">
        <p className="text-sm text-negative">{(e as Error).message}</p>
      </Panel>
    );
  }

  const externalViewer = externalPortfolioViewer(result.chain, result.address);
  // Wallet Watch: offer to watch this address, or say who it's watched as —
  // names and addresses only (no snapshots or prices: those read every price).
  // The holdings table's chain icons load alongside (cached per request).
  const [watch] = await Promise.all([(await getUser()) ? getWatchFeedTargets() : null, getChainIconMap()]);
  const normalized = normalizeWatchAddress(result.address);
  const watchedAs = watch?.influencers.find((i) => i.addresses.some((a) => a.address === normalized));

  return (
    <>
      <Panel className="mb-6">
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
          <span>
            {result.chain} · {result.address}
          </span>
          {externalViewer && (
            <a
              href={externalViewer.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`View on ${externalViewer.label}`}
              aria-label={`View on ${externalViewer.label}`}
              className="text-fg-muted transition hover:text-fg"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          )}
        </p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">
          {formatUsd(result.total)}
        </p>
        <div className="mt-3 flex flex-wrap items-start gap-2">
          {/* Anyone can open a lookup link, signed in or not. */}
          <ShareLinkButton paths={[`/lookup?address=${encodeURIComponent(result.address)}`]} />
        </div>
        {watch && (
          <div className="mt-3">
            {watchedAs ? (
              <Link href={`/wallet-watch/${watchedAs.id}`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
                <Eye className="size-3.5" aria-hidden="true" /> Watching as {watchedAs.name}
              </Link>
            ) : (
              <WatchAddressForm
                options={{ influencers: watch.influencers.map((i) => ({ id: i.id, name: i.name })), groups: watch.groups }}
                address={result.address}
                label="Watch this wallet"
              />
            )}
          </div>
        )}
        {result.warnings.length > 0 && (
          <p className="mt-2 text-sm text-warning">
            {result.warnings.length} source{result.warnings.length === 1 ? "" : "s"} failed to load and may
            be missing from the totals below — try again in a moment.
          </p>
        )}
      </Panel>

      <ChainGroupedHoldings
        groups={result.chainGroups}
        grandTotal={result.total}
        selectedChain={selectedChain}
        selectedProtocol={selectedProtocol}
        hideUnpriced={hideUnpriced}
        hideLow={hideLow}
        baseHref={`/lookup?address=${encodeURIComponent(address)}`}
        emptyMessage="No holdings found for this address."
      />
    </>
  );
}

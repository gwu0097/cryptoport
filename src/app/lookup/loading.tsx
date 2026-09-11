import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";

// Next's file-based Suspense boundary for this route segment: shown
// immediately on navigation (even on the plain-GET hard nav the search form
// does) while lookup/page.tsx's on-chain fetch — the same slow Multicall3 +
// CoinGecko/Jupiter work a wallet's "Sync holdings" does — is still in
// flight, then swapped for the real content once it resolves.
export default function LookupLoading() {
  return (
    <>
      <PageHeader
        title="Wallet lookup"
        subtitle="Search any ETH, SOL, BTC, or ADA address — read-only, nothing is saved to your portfolio."
      />
      <Panel className="flex flex-col items-center gap-3 py-12 text-center">
        <Loader2 className="size-6 animate-spin text-accent" aria-hidden="true" />
        <p className="text-sm text-fg-muted">Reading on-chain balances…</p>
      </Panel>
    </>
  );
}

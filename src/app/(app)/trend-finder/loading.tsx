import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";

// Route-specific rather than relying on (app)/loading.tsx's generic
// skeleton — a cold-cache Trend Finder render can chain several throttled
// CoinGecko calls (see trendPeers.ts), noticeably slower than a normal page
// here, so this says why rather than leaving a bare spinner (the "say why
// in the UI" loading-feedback rule).
export default function TrendFinderLoading() {
  return (
    <>
      <PageHeader
        title="Trend finder"
        subtitle="Pick a token that already moved — see sector peers that haven't yet."
      />
      <Panel className="flex flex-col items-center gap-3 py-12 text-center">
        <Loader2 className="size-6 animate-spin text-accent" aria-hidden="true" />
        <p className="text-sm text-fg-muted">Looking up sector peers — a first-time token can take a few seconds…</p>
      </Panel>
    </>
  );
}

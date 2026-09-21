import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";

// Route-specific rather than relying on (app)/loading.tsx's generic
// skeleton — needed for the same reason as trend-finder/loading.tsx: a
// tab click here (e.g. Trend Finder) is a searchParams-only navigation on
// the same route, which re-suspends EncyclopediaPage under its nearest
// loading.tsx boundary rather than remounting the (app) segment, so
// without a boundary of its own the click showed nothing until the
// (potentially 20-30s, uncached) fetch finished — reported directly: "it's
// doing that thing where it loads without going anywhere and then shows up
// after it's done."
export default function EncyclopediaLoading() {
  return (
    <>
      <PageHeader
        title="Encyclopedia"
        subtitle="Search any token — chart, trend analysis, and AI research, all in one place."
      />
      <Panel className="flex flex-col items-center gap-3 py-12 text-center">
        <Loader2 className="size-6 animate-spin text-accent" aria-hidden="true" />
        <p className="text-sm text-fg-muted">
          Loading — a first-time trend or AI lookup can take up to 20-30 seconds…
        </p>
      </Panel>
    </>
  );
}

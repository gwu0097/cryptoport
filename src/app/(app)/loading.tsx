import { Panel } from "@/components/ui/Panel";

// Shared across every page under (app)/ — Next automatically wraps each
// page.tsx (and any nested layouts) in a Suspense boundary keyed to this
// file, showing it immediately on navigation while that page's own async
// data fetch is still in flight, then swapping in the real content once
// it resolves. Every page here is `dynamic = "force-dynamic"` (always a
// live server round-trip, never a cached/static response), so without
// this every tab switch used to show nothing at all for however long that
// round-trip took — this is the fix, not a spinner slapped on top of the
// real problem. One generic skeleton for the whole section rather than a
// bespoke one per page: every page here already shares the same rough
// shape (a header, a "Total value"-style panel, then a table), so one
// approximation covers all of them reasonably well.
export default function Loading() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="mb-6 h-7 w-40 rounded bg-surface-raised" />

      <Panel className="mb-6">
        <div className="h-4 w-24 rounded bg-surface-raised" />
        <div className="mt-2 h-8 w-48 rounded bg-surface-raised" />
      </Panel>

      <Panel padding={false} className="overflow-hidden">
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-12 bg-surface-raised/40" />
          ))}
        </div>
      </Panel>
    </div>
  );
}

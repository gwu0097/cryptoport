import { Panel } from "@/components/ui/Panel";

// Going from one influencer to another only changes [id], so (app)/loading.tsx
// never shows (its boundary sits above wallet-watch, which didn't change) and
// the previous page stayed frozen until the next one rendered. This boundary
// is keyed to [id]: a click shows this at once, shaped like the page (value,
// trading record, chart, activity).
export default function Loading() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="mb-3 h-4 w-24 rounded bg-surface-raised" />
      <div className="mb-6 h-7 w-48 rounded bg-surface-raised" />
      <Panel className="mb-4">
        <div className="h-8 w-40 rounded bg-surface-raised" />
        <div className="mt-3 h-4 w-56 rounded bg-surface-raised" />
      </Panel>
      <Panel className="mb-4">
        <div className="h-5 w-32 rounded bg-surface-raised" />
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-surface-raised/60" />
          ))}
        </div>
      </Panel>
      <Panel className="mb-4">
        <div className="h-5 w-32 rounded bg-surface-raised" />
        <div className="mt-4 h-40 rounded bg-surface-raised/60" />
      </Panel>
      <Panel>
        <div className="h-5 w-24 rounded bg-surface-raised" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="mt-3 h-6 rounded bg-surface-raised/40" />
        ))}
      </Panel>
    </div>
  );
}

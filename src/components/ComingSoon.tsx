import type { LucideIcon } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { Panel } from "./ui/Panel";

export function ComingSoon({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <>
      <PageHeader title={title} />
      <Panel className="grid min-h-64 place-items-center text-center">
        <div className="flex flex-col items-center gap-3">
          <Icon className="size-10 text-fg-muted" aria-hidden="true" />
          <p className="max-w-sm text-sm text-fg-muted">{description}</p>
          <span className="rounded-full border border-border px-3 py-1 text-xs text-fg-muted">
            Coming soon
          </span>
        </div>
      </Panel>
    </>
  );
}

import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {/* items-start, not items-center — an action can be a button with a
          caption underneath it (e.g. "Refresh prices" + "Last priced: Xm
          ago" on the wallets page), which is taller than a plain button;
          items-start keeps every action's own button top-aligned with the
          rest regardless, instead of the whole row centering around
          whichever action happens to be tallest. */}
      {actions && <div className="flex items-start gap-3">{actions}</div>}
    </div>
  );
}

import type { ReactNode } from "react";

/**
 * The card every section sits in. `actions`: controls at the right of the
 * title row (a refresh button, a "view all" link); `footer`: a line under
 * the content; `density="compact"`: tighter padding and a smaller title,
 * for dashboard cards.
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  density = "normal",
  padding = true,
  className = "",
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  density?: "normal" | "compact";
  padding?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const compact = density === "compact";
  const pad = padding ? (compact ? "p-4" : "p-5") : "";
  const hasHeader = Boolean(title || description || actions);
  return (
    <div className={`rounded-xl border border-border bg-surface ${pad} ${className}`}>
      {hasHeader && (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            {title && <h2 className={`${compact ? "text-sm" : "text-base"} font-semibold text-fg`}>{title}</h2>}
            {description && <p className={`mt-1 ${compact ? "text-xs" : "text-sm"} text-fg-muted`}>{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {hasHeader ? <div className={compact ? "mt-3" : "mt-4"}>{children}</div> : children}
      {footer && <div className={`${compact ? "mt-3" : "mt-4"} border-t border-border pt-3 text-xs text-fg-muted`}>{footer}</div>}
    </div>
  );
}

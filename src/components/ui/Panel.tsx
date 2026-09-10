import type { ReactNode } from "react";

export function Panel({
  title,
  description,
  padding = true,
  className = "",
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  padding?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface ${padding ? "p-5" : ""} ${className}`}
    >
      {title && <h2 className="text-base font-semibold text-fg">{title}</h2>}
      {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      {(title || description) && <div className="mt-4">{children}</div>}
      {!title && !description && children}
    </div>
  );
}

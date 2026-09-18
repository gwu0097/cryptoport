"use client";

/**
 * A plain external link that stops its click from also toggling an
 * ancestor <details>/<summary> — needed wherever a link lives inside a
 * clickable section header (ChainGroupedHoldings' protocol sub-headers).
 * Event handlers on a host element can't be passed from a Server
 * Component's own JSX at all (a real build-time-invisible, runtime-only
 * error — caught live, not by tsc/lint), so this one-line interactive bit
 * has to live in its own "use client" file rather than inline in the
 * server-rendered markup around it.
 */
export function StopPropagationLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={className}
    >
      {children}
    </a>
  );
}

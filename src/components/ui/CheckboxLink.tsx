import Link from "next/link";

/** A checkbox that's actually a link: `pointer-events-none` on the `<input>`
 * stops it from toggling itself on click (native checkboxes ignore
 * `readOnly`), so the click passes through to the wrapping `<Link>` instead.
 * Keeps the whole page server-rendered with URL state, no client JS,
 * matching this codebase's established pattern of searchParams-based
 * filtering over client state. Shared by ChainGroupedHoldings and the
 * ticker-grouped Assets page. */
export function CheckboxLink({
  href,
  checked,
  label,
}: {
  href: string;
  checked: boolean;
  label: string;
}) {
  return (
    <Link href={href} className="flex items-center gap-2 text-sm text-fg-muted hover:text-fg">
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="pointer-events-none size-4 rounded border-border accent-accent"
      />
      {label}
    </Link>
  );
}

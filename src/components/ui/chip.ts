/** A filter chip sized to its content (a chain, a protocol): icon, name and
 * a muted figure on one line. `compact`: the quieter second row. */
export function chipClass(active: boolean, compact = false): string {
  const base = `inline-flex items-center gap-1.5 rounded-lg border transition ${compact ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm"}`;
  return active ? `${base} border-accent bg-surface-raised` : `${base} border-border bg-surface hover:border-accent/50 hover:bg-surface-raised`;
}

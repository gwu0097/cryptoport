export const tableClass = "w-full border-collapse text-left";
export const theadRowClass = "border-b border-border text-left text-xs uppercase tracking-wide text-fg-muted";
export const thClass = "px-3 py-2 font-medium";
export const trClass = "border-b border-border/60 hover:bg-surface-raised/50";
export const tdClass = "px-3 py-3 text-sm";

// Appended to a <th>/<td>'s own class string (not a replacement for
// thClass/tdClass) to drop a secondary column below `sm` — every data
// table in this app still scrolls horizontally rather than losing columns
// entirely (see each table's own overflow-x-auto wrapper), but a phone
// screen shouldn't need to scroll sideways just to see Value next to the
// name — the column that actually answers "what is this and what's it
// worth" stays, the rest (qty, tags, sync timestamps, ...) is one tap of
// horizontal scroll away instead of gone, on a wider screen it's back.
export const hideOnMobileClass = "hidden sm:table-cell";

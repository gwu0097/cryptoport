// Plain grouping logic shared by ChainGroupedHoldings.tsx and DefiTable.tsx
// — both need the identical section order for a protocol's holdings (see
// AdapterHolding.protocol_section's own doc comment), so this lives here
// once rather than as two copies that could quietly drift apart.

// Hyperliquid's own narrative order (Deposit -> open positions -> yield ->
// rewards) — the only adapter using sections today. Anything not in this
// list (a future protocol's own section names) sorts after these by name,
// rather than being silently dropped.
const SECTION_ORDER = ["Deposit", "Perpetuals", "Yield", "Rewards"];

function sectionRank(section: string): number {
  const idx = SECTION_ORDER.indexOf(section);
  return idx === -1 ? SECTION_ORDER.length : idx;
}

export interface SectionGroup<T> {
  section: string | null;
  holdings: T[];
}

/**
 * Splits a protocol's holdings by `protocol_section`, in a fixed display
 * order — null (no section) sorts first so a protocol using sections for
 * only some of its holdings doesn't bury its unlabeled ones. Every existing
 * protocol (no adapter sets protocol_section except hyperliquid.ts) comes
 * back as one group with `section: null`, so a caller can treat that single-
 * group/null case as "render flat, no headers" and stay pixel-identical to
 * before this existed.
 */
export function groupBySection<T extends { protocol_section: string | null }>(holdings: T[]): SectionGroup<T>[] {
  const bySection = new Map<string | null, T[]>();
  for (const h of holdings) {
    const key = h.protocol_section;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key)!.push(h);
  }
  return [...bySection.entries()]
    .map(([section, holdings]) => ({ section, holdings }))
    .sort((a, b) => {
      if (a.section === null) return -1;
      if (b.section === null) return 1;
      return sectionRank(a.section) - sectionRank(b.section);
    });
}

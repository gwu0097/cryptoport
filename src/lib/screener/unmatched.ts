// Change-only unmatched log (pure diff — see unmatched.test.ts). The old
// `screener_unmatched_log` wrote every unmatched protocol on every run:
// 7,307 rows/run ≈ 1.34 MB/day ≈ 490 MB/yr, measured 2026-09-22 — the
// single largest daily writer once snapshot provenance was slimmed. The
// replacement (`screener_unmatched`) stores one row per continuous
// unmatched interval: opened the first run an item appears, closed
// (`resolved_run_id`) the first run it's gone. "Log, don't drop" still
// holds — every item a run couldn't match is findable as an open row —
// it's just not re-written 7K times a day.

export type UnmatchedKind = "no_gecko_id" | "no_fee_data" | "no_coingecko_market_data";

export interface UnmatchedEntry {
  kind: UnmatchedKind;
  identifier: string;
  reason: string;
}

export interface OpenUnmatchedRow {
  id: string;
  kind: string;
  identifier: string;
  reason: string | null;
}

export interface UnmatchedDiff {
  /** Unmatched this run, not currently open — insert as new open rows. */
  toOpen: UnmatchedEntry[];
  /** Open rows no longer unmatched this run — close them. */
  toResolveIds: string[];
  /** Still unmatched, same (kind, identifier), but the reason text changed. */
  reasonUpdates: { id: string; reason: string }[];
}

const key = (kind: string, identifier: string) => `${kind}\u0000${identifier}`;

export function diffUnmatched(open: readonly OpenUnmatchedRow[], current: readonly UnmatchedEntry[]): UnmatchedDiff {
  const currentByKey = new Map<string, UnmatchedEntry>();
  for (const e of current) currentByKey.set(key(e.kind, e.identifier), e);

  const openKeys = new Set<string>();
  const toResolveIds: string[] = [];
  const reasonUpdates: { id: string; reason: string }[] = [];
  for (const row of open) {
    const k = key(row.kind, row.identifier);
    openKeys.add(k);
    const now = currentByKey.get(k);
    if (!now) toResolveIds.push(row.id);
    else if (now.reason !== row.reason) reasonUpdates.push({ id: row.id, reason: now.reason });
  }

  const toOpen = [...currentByKey.entries()].filter(([k]) => !openKeys.has(k)).map(([, e]) => e);
  return { toOpen, toResolveIds, reasonUpdates };
}

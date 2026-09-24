// A sync replaces all of a wallet's auto-synced rows at once
// (sync_auto_holdings / sync_cosmos_holdings: delete, then insert). When one
// part of a sync fails (a chain's RPC, a staking contract, a DeFi API, a
// CoinGecko 429) that part returns nothing, and its rows used to vanish
// until a later sync happened to succeed — 385 staked AXS disappeared from a
// Ronin wallet that way (2026-09-24). Each soft-failing part now names the
// rows it owns with a KeepScope; the sync re-saves the wallet's previous
// rows in those scopes, unchanged, and says so in the wallet's status.
//
// Pure (no DB, no network) so it's unit-testable with node --test.

/** The row fields a scope can match on — present on AdapterHolding,
 * CosmosHolding and a stored holdings row alike. */
export interface KeepableRow {
  ticker: string;
  chain: string | null;
  contract: string | null;
  category: string;
  protocol?: string | null;
  protocol_section?: string | null;
  display_label?: string | null;
}

export interface KeepScope {
  /** Named in the wallet's status: "kept from the last sync: <label>". */
  label: string;
  owns: (row: KeepableRow) => boolean;
}

/** One position's identity: a kept row is skipped when this sync already
 * produced the same position fresh (e.g. a chain whose native balance was
 * read but whose token prices failed — only the tokens are carried). */
function identity(row: KeepableRow): string {
  return [row.chain, row.contract, row.ticker, row.category, row.protocol, row.protocol_section, row.display_label]
    .map((v) => v ?? "")
    .join("|");
}

export function carryForward<T extends KeepableRow>(
  fresh: T[],
  previous: T[],
  scopes: KeepScope[],
): { holdings: T[]; kept: { label: string; count: number }[] } {
  if (scopes.length === 0) return { holdings: fresh, kept: [] };
  const freshIds = new Set(fresh.map(identity));
  const out = [...fresh];
  const kept: { label: string; count: number }[] = [];
  const taken = new Set<T>();
  for (const scope of scopes) {
    let count = 0;
    for (const row of previous) {
      if (taken.has(row) || freshIds.has(identity(row)) || !scope.owns(row)) continue;
      taken.add(row);
      out.push(row);
      count++;
    }
    if (count > 0) kept.push({ label: scope.label, count });
  }
  return { holdings: out, kept };
}

/** Appended to a partial sync's status so a kept row's amounts are never
 * mistaken for fresh ones. Empty when nothing was kept. */
export function keptNote(kept: { label: string; count: number }[]): string {
  if (kept.length === 0) return "";
  const parts = kept.map((k) => `${k.label} (${k.count} row${k.count === 1 ? "" : "s"})`);
  return `kept from the last sync, not refreshed: ${parts.join(", ")}`;
}

// Scope builders shared by the adapters.

export const chainScope = (label: string, chain: string): KeepScope => ({
  label,
  owns: (r) => r.chain === chain,
});

export const protocolScope = (label: string, ...prefixes: string[]): KeepScope => ({
  label,
  owns: (r) => !!r.protocol && prefixes.some((p) => r.protocol === p || r.protocol!.startsWith(`${p} `) || r.protocol!.startsWith(`${p}:`)),
});

// Wallet Watch (docs/wallet-watch/PLAN.md): what is stored for a watched
// address, and the small rules around it. Pure.
//
// The snapshot keeps what can matter to a movement (phase 2 counts changes of
// $100 or more): holdings worth at least SNAPSHOT_MIN_USD, every position,
// rows a failed source carried forward from the last read, and anything that
// was stored last time but is unpriced, unrecognized or dust today — so the
// diff never mistakes "couldn't read" or "lost its price today" for "sold".
// Dust and spam an address was never seen holding are only counted: one
// real wallet (2026-09-26) held 3,992 unrecognized tokens and 369 holdings
// under $1, which made a full snapshot 593 KB.

import type { AdapterHolding } from "./adapters/types.ts";

/** A stored row: an adapter row with its price key, null fields dropped to
 * keep the jsonb small. `kept` marks a row carried forward from the previous
 * snapshot because its source failed this time. */
export type SnapshotRow = Partial<AdapterHolding> & {
  ticker: string;
  category: string;
  price_key?: string | null;
  kept?: true;
};

export interface SnapshotUnrecognized {
  chain: string;
  contract: string;
  symbol: string;
  /** Whole tokens; null when decimals couldn't be read. */
  amount: number | null;
}

export interface WatchSnapshot {
  rows: SnapshotRow[];
  /** Only tokens stored as holdings last time (a price gap, not spam). */
  unrecognized: SnapshotUnrecognized[];
  /** Every token held but not counted this read, and the dust left out. */
  unrecognizedCount?: number;
  dustCount?: number;
  /** What the dust left out was worth at this read, together. */
  dustUsd?: number;
}

/** A token row worth less than this, never stored before, is only counted. */
export const SNAPSHOT_MIN_USD = 1;

const tokenKey = (chain: string | null | undefined, contract: string | null | undefined) => `${chain ?? ""}|${(contract ?? "").toLowerCase()}`;

/** Trimmed; an EVM (0x) address lowercased, so one address is one row. */
export function normalizeWatchAddress(raw: string): string {
  const a = raw.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a;
}

function compact<T extends object>(row: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(row) as [keyof T, T[keyof T]][]) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * `valueOf` is a row's current dollar value (null when unpriced);
 * `previous` is the last stored snapshot.
 */
export function buildSnapshot(
  fresh: readonly (AdapterHolding & { price_key?: string | null })[],
  kept: readonly SnapshotRow[],
  unrecognized: readonly SnapshotUnrecognized[],
  valueOf: (row: AdapterHolding & { price_key?: string | null }) => number | null,
  previous: WatchSnapshot | null = null,
): WatchSnapshot {
  const stored = new Set((previous?.rows ?? []).filter((r) => r.contract).map((r) => tokenKey(r.chain, r.contract)));
  const rows: SnapshotRow[] = [];
  let dustCount = 0;
  let dustUsd = 0;
  for (const r of fresh) {
    const v = valueOf(r);
    const keep = r.category !== "token" || (v !== null && v >= SNAPSHOT_MIN_USD) || (!!r.contract && stored.has(tokenKey(r.chain, r.contract)));
    if (keep) rows.push(compact(r) as SnapshotRow);
    else {
      dustCount++;
      dustUsd += v ?? 0;
    }
  }
  return {
    rows: [...rows, ...kept.map((r) => ({ ...r, kept: true as const }))],
    unrecognized: unrecognized
      .filter((u) => stored.has(tokenKey(u.chain, u.contract)))
      .map((u) => ({ chain: u.chain, contract: u.contract, symbol: u.symbol, amount: u.amount })),
    unrecognizedCount: unrecognized.length,
    dustCount,
    dustUsd,
  };
}

/** The previous snapshot's tokens per chain (lowercased contracts), for the
 * EVM read's `previous` — discovery then always re-reads what the address
 * held last time, even if the indexer misses it today. */
export function previousContracts(snapshot: WatchSnapshot | null): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (chain: string | null | undefined, contract: string | null | undefined) => {
    if (!chain || !contract) return;
    const set = out.get(chain) ?? new Set<string>();
    set.add(contract.toLowerCase());
    out.set(chain, set);
  };
  for (const r of snapshot?.rows ?? []) if (r.category === "token") add(r.chain, r.contract);
  for (const u of snapshot?.unrecognized ?? []) add(u.chain, u.contract);
  return new Map([...out].map(([chain, set]) => [chain, [...set]]));
}

/** A stored row back in the adapter shape (nulls restored), for
 * carryForward and valuation. */
export function snapshotRowToAdapter(r: SnapshotRow): AdapterHolding & { price_key: string | null } {
  const row = { ...r };
  delete row.kept;
  return {
    qty: null,
    usd_override: null,
    contract: null,
    icon_url: null,
    ...row,
    category: row.category as AdapterHolding["category"],
    chain: row.chain ?? "",
    price_key: row.price_key ?? null,
  };
}

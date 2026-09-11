// Pure, deliberately NOT server-only (unlike tokenRegistry.ts, which
// imports this): no DB, no network — kept separate specifically so this
// stays unit-testable with plain `node --test` outside Next's bundler
// (importing anything that pulls in "server-only" would throw
// unconditionally there, same reasoning as coinbase.ts/walletAuth.ts).

/** Postgres' ON CONFLICT can't touch the same row twice within a single
 * upsert statement — a real crash hit this ("ON CONFLICT DO UPDATE command
 * cannot affect row a second time"), against Ethereum's 5,800+ row
 * registry, from a duplicate contract landing in the same batch. Dedupe by
 * (chain_id, contract) regardless of how a caller built the row list —
 * cheap, unconditional insurance against that whole class of error,
 * whichever upstream source (an RPC page, a CoinGecko listing) produced
 * the duplicate. Keeps the last-seen row for a given key (Map semantics). */
export function dedupeTokenRegistryRows<T extends { chain_id: string; contract: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((r) => [`${r.chain_id}:${r.contract}`, r])).values()];
}

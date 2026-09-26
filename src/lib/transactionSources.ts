// Which sources a chain's transaction history is read from, in order — the
// first one that answers wins (transactionDispatch.ts). Alchemy where its
// Transfers API answers; Etherscan where its free tier covers the chain;
// Blockscout where the chain runs a working instance. A source that fails
// passes the chain to the next; a chain whose sources all fail keeps its saved
// history. Pure.

export type TxSource = "alchemy" | "etherscan" | "blockscout";

export function txSourcesFor(
  chain: string,
  covered: { alchemy: ReadonlySet<string>; etherscan: ReadonlySet<string>; blockscout: ReadonlySet<string> },
): TxSource[] {
  return (["alchemy", "etherscan", "blockscout"] as const).filter((s) => covered[s].has(chain));
}

/** The status line of a transaction sync: the count saved, then any chains
 * whose history was kept from the last sync (every source failed) and any
 * held chains with no source at all. "partial" when a chain failed. */
export function txSyncStatus(saved: number, failed: readonly { chain: string; error: string }[], unsupported: readonly string[]): string {
  const notes = [
    ...(failed.length > 0 ? [`kept from last sync: ${failed.map((f) => `${f.chain} (${f.error.slice(0, 80)})`).join("; ")}`] : []),
    ...(unsupported.length > 0 ? [`no history source for ${unsupported.join(", ")}`] : []),
  ];
  if (failed.length > 0) return `partial — ${saved} saved; ${notes.join("; ")}`;
  return notes.length > 0 ? `ok (${saved}) · ${notes.join("; ")}` : `ok (${saved})`;
}

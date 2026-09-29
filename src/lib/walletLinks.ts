// Evidence that a suggested wallet belongs to a KOL (docs/wallet-watch/
// DIRECTORY.md, phase 2): the transfers between it and the KOL's known
// wallets. Money going both ways, more than once, is how one person moves
// funds between their own wallets (VirtualBacon's 987K AURORA to his second
// wallet); a single transfer in proves nothing — anyone can send tokens to
// any address, which is exactly how a fake suggestion would try to look
// linked. Pure.

export interface LinkTransfer {
  chain: string;
  from: string;
  to: string;
  asset: string | null;
  value: number | null;
  at: string;
  txId: string;
}

export type LinkStrength = "strong" | "one-way" | "none";

export interface LinkEvidence {
  strength: LinkStrength;
  /** Transfers from a known wallet to the suggested one, and back. */
  toSuggested: number;
  fromSuggested: number;
  chains: string[];
  assets: string[];
  first: string | null;
  last: string | null;
  /** A few of the transfers, newest first, to open on an explorer. */
  examples: LinkTransfer[];
  checkedAt: string;
}

const lower = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);

/** What the transfers between `suggested` and `known` show. Strong: both
 * directions, at least three transfers in all (by transaction). */
export function summarizeLinks(transfers: readonly LinkTransfer[], known: readonly string[], suggested: string, checkedAt: string): LinkEvidence {
  const k = new Set(known.map(lower));
  const s = lower(suggested);
  const seen = new Set<string>();
  const links = transfers.filter((t) => {
    const from = lower(t.from);
    const to = lower(t.to);
    const linked = (k.has(from) && to === s) || (from === s && k.has(to));
    const key = `${t.txId}|${from}|${to}`;
    if (!linked || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const toSuggested = new Set(links.filter((t) => lower(t.to) === s).map((t) => t.txId)).size;
  const fromSuggested = new Set(links.filter((t) => lower(t.from) === s).map((t) => t.txId)).size;
  const times = links.map((t) => t.at).sort();
  const strength: LinkStrength = toSuggested > 0 && fromSuggested > 0 && toSuggested + fromSuggested >= 3 ? "strong" : links.length > 0 ? "one-way" : "none";
  return {
    strength,
    toSuggested,
    fromSuggested,
    chains: [...new Set(links.map((t) => t.chain))],
    assets: [...new Set(links.map((t) => t.asset).filter((a): a is string => !!a))].slice(0, 8),
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
    examples: [...links].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5),
    checkedAt,
  };
}

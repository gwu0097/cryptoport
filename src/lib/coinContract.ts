// Which of a coin's contracts to copy (the Dashboard movers' copy button):
// a coin listed on many chains (ENA: 15) gives its home chain's — Ethereum
// first, then Solana and the large L2s. Pure.

const PRIORITY = ["eth", "solana", "base", "arb", "bsc", "op", "matic", "avax", "rbh"];

export function pickContract(rows: readonly { chain_id: string; contract: string }[]): { chain: string; contract: string } | null {
  if (rows.length === 0) return null;
  const rank = (c: string) => {
    const i = PRIORITY.indexOf(c);
    return i === -1 ? PRIORITY.length : i;
  };
  const best = [...rows].sort((a, b) => rank(a.chain_id) - rank(b.chain_id) || a.chain_id.localeCompare(b.chain_id))[0];
  return { chain: best.chain_id, contract: best.contract };
}

// Which token address an Assets row copies (pure): the contract of the
// holding itself — no request — when it is a real token address (EVM
// 0x…, Solana base58, Sui 0x…::module::NAME). A chain's own coin, a Cosmos
// denom (uakt, ibc/…), a venue balance or a position has none.

const SHAPES = [/^0x[0-9a-fA-F]{40}$/, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, /^0x[0-9a-fA-F]{1,64}::\w+::\w+$/];

export function isTokenAddress(contract: string | null | undefined): contract is string {
  return !!contract && SHAPES.some((re) => re.test(contract));
}

/** The row's address to copy — the largest holding's when the coin sits on
 * several chains — and how many distinct addresses the row has. */
export function assetContract(
  holdings: readonly { contract?: string | null; chainName: string; valuation: { kind: string; usd?: number } }[],
): { contract: string; chainName: string; distinct: number } | null {
  const withAddress = holdings.filter((h): h is typeof h & { contract: string } => isTokenAddress(h.contract));
  if (withAddress.length === 0) return null;
  const usd = (h: (typeof withAddress)[number]) => (h.valuation.kind === "priced" ? (h.valuation.usd ?? 0) : 0);
  const best = [...withAddress].sort((a, b) => usd(b) - usd(a))[0];
  return { contract: best.contract, chainName: best.chainName, distinct: new Set(withAddress.map((h) => h.contract)).size };
}

// Which tokens an EVM chain scan reads, and what becomes of each one it finds
// (docs/sync/PLAN.md D2/D3). Pure: the network halves are
// adapters/alchemyDiscovery.ts, adapters/receiptTokens.ts and
// adapters/multicallEvm.ts.

export interface TokenInfo {
  contract: string; // lowercase
  symbol: string;
  decimals: number | null;
  coingecko_id: string | null;
  image_url: string | null;
  /** In token_registry (CoinGecko's contract → coin list). */
  listed: boolean;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The tokens to read on one chain: what discovery found ∪ what the wallet
 * held there last sync ∪ (when discovery didn't complete) every listed token,
 * keyed by lowercase contract so a token from two paths is read once. A
 * contract whose coin is the chain's native coin is dropped — CoinGecko lists
 * CELO's ERC-20 and Mantle's 0xdead… for the native coin, which the separate
 * native balance already counts. Registry info is used where the contract is
 * listed; anything else is an unlisted token whose metadata is read on-chain.
 */
export function candidateTokens(args: {
  discovered: readonly string[];
  previous: readonly string[];
  registry: readonly Omit<TokenInfo, "listed">[];
  includeWholeRegistry: boolean;
  nativeCoingeckoId: string;
}): TokenInfo[] {
  const known = new Map(args.registry.map((t) => [t.contract.toLowerCase(), t]));
  const contracts = new Set<string>([
    ...args.discovered.map((c) => c.toLowerCase()),
    ...args.previous.map((c) => c.toLowerCase()),
    ...(args.includeWholeRegistry ? [...known.keys()] : []),
  ]);
  const out: TokenInfo[] = [];
  for (const contract of contracts) {
    if (!ADDRESS.test(contract)) continue;
    const r = known.get(contract);
    if (r?.coingecko_id && r.coingecko_id === args.nativeCoingeckoId) continue;
    out.push(r ? { ...r, contract, listed: true } : { contract, symbol: "", decimals: null, coingecko_id: null, image_url: null, listed: false });
  }
  return out;
}

export interface HeldToken {
  token: TokenInfo;
  qty: number | null; // null when decimals couldn't be read
  raw: bigint;
}

/** A held token recognised as a DeFi receipt, valued as its underlying coin. */
export interface ReceiptValuation {
  underlyingId: string;
  underlyingSymbol: string;
  underlyingQty: number;
}

export type Classified =
  | { kind: "counted"; held: HeldToken }
  | { kind: "receipt"; held: HeldToken; as: ReceiptValuation }
  | { kind: "dust"; held: HeldToken }
  | { kind: "unrecognized"; held: HeldToken; reason: "unlisted" | "unpriced" };

/**
 * What each held token becomes (docs/sync/PLAN.md D3):
 *  - counted: its coin (price_key) has a price and it's worth more than dust;
 *  - receipt: a standard DeFi receipt CoinGecko doesn't price (aTkoWETH),
 *    valued as its underlying amount at the underlying coin's price (owner
 *    decision 2026-09-25);
 *  - dust: priced, but worth `floorUsd` or less — known to be ~0, not listed;
 *  - unrecognized: anything else — kept per wallet, never in totals, never
 *    silently dropped.
 */
export function classifyHeld(
  held: HeldToken,
  prices: ReadonlyMap<string, number>,
  receipt: ReceiptValuation | undefined,
  floorUsd: number,
): Classified {
  const price = held.token.coingecko_id ? prices.get(held.token.coingecko_id) : undefined;
  if (price !== undefined && held.qty !== null) {
    return held.qty * price > floorUsd ? { kind: "counted", held } : { kind: "dust", held };
  }
  if (receipt) {
    const underlyingPrice = prices.get(receipt.underlyingId);
    if (underlyingPrice !== undefined) {
      return receipt.underlyingQty * underlyingPrice > floorUsd ? { kind: "receipt", held, as: receipt } : { kind: "dust", held };
    }
  }
  return { kind: "unrecognized", held, reason: held.token.coingecko_id ? "unpriced" : "unlisted" };
}

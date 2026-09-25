// A liquid staking or vault receipt token (MaticX, eETH, a Morpho vault share)
// is the same money as the protocol position it stands for. The wallet sync
// lists the token; Zerion lists the position (in the underlying coin), and its
// pool contract IS the token's contract. Each must count once (2026-09-25:
// +$1,256 on one wallet vs DeBank). Which copy stays depends on whether the
// token can be sold without unstaking (owner decision):
//  - tradable (a real market) → keep the wallet token, priced by its own
//    market price; drop the duplicate position;
//  - not tradable → keep the position (where it's staked, how to withdraw);
//    drop the wallet copy.
// Tradable = CoinGecko's 24h trading volume (asset_prices.volume_24h, all
// venues) at or above TRADABLE_MIN_VOLUME_USD; unlisted or no volume = not
// tradable. Pure.

export const TRADABLE_MIN_VOLUME_USD = 10_000;

export const receiptKey = (chain: string, contract: string) => `${chain}|${contract.toLowerCase()}`;

export function isTradable(volume24h: number | null | undefined): boolean {
  return typeof volume24h === "number" && Number.isFinite(volume24h) && volume24h >= TRADABLE_MIN_VOLUME_USD;
}

/** The key whose trading volume says whether a held token is tradable: its
 * own price_key — or none when it's priced as another coin (`coingecko_id`
 * set: a receipt CoinGecko doesn't list, valued as its underlying,
 * multicallEvm.ts). The underlying's volume says nothing about the receipt's
 * own market, so such a token is never tradable. */
function ownMarketKey(t: { price_key?: string | null; coingecko_id?: string | null }): string | null {
  return t.coingecko_id ? null : (t.price_key ?? null);
}

/** Drops positions whose pool is a token this wallet holds and
 * that token is tradable (the wallet row already counts it).
 * `heldKeys`: receiptKey(chain, contract) -> that wallet token's price_key. */
export function dropTradableReceiptPositions<T extends { chain: string | null; pool_contract?: string | null }>(
  positions: readonly T[],
  heldKeys: ReadonlyMap<string, string | null>,
  volumeByKey: ReadonlyMap<string, number | null>,
): T[] {
  return positions.filter((p) => {
    if (!p.chain || !p.pool_contract) return true;
    const k = receiptKey(p.chain, p.pool_contract);
    if (!heldKeys.has(k)) return true;
    const priceKey = heldKeys.get(k);
    return !(priceKey && isTradable(volumeByKey.get(priceKey)));
  });
}

/** Drops tokens that are the receipt of one of this wallet's
 * DeFi positions and can't be traded (the position row counts it).
 * `poolKeys`: receiptKey(chain, pool_contract) of the wallet's DeFi rows. */
export function dropUntradableReceiptTokens<T extends { chain: string | null; contract: string | null; price_key?: string | null; coingecko_id?: string | null }>(
  tokens: readonly T[],
  poolKeys: ReadonlySet<string>,
  volumeByKey: ReadonlyMap<string, number | null>,
): T[] {
  return tokens.filter((t) => {
    if (!t.chain || !t.contract || !poolKeys.has(receiptKey(t.chain, t.contract))) return true;
    const key = ownMarketKey(t);
    return !!key && isTradable(volumeByKey.get(key));
  });
}

/** Both sides at once, from one sync's fresh lists (the wallet's tokens and
 * its DeFi positions): each receipt ends up counted exactly once. */
export function dedupeReceipts<
  Tok extends { chain: string | null; contract: string | null; price_key?: string | null; coingecko_id?: string | null },
  Pos extends { chain: string | null; pool_contract?: string | null },
>(tokens: readonly Tok[], positions: readonly Pos[], volumeByKey: ReadonlyMap<string, number | null>): { tokens: Tok[]; positions: Pos[] } {
  const held = new Map<string, string | null>();
  for (const t of tokens) if (t.chain && t.contract) held.set(receiptKey(t.chain, t.contract), ownMarketKey(t));
  const pools = new Set<string>();
  for (const p of positions) if (p.chain && p.pool_contract) pools.add(receiptKey(p.chain, p.pool_contract));
  return {
    tokens: dropUntradableReceiptTokens(tokens, pools, volumeByKey),
    positions: dropTradableReceiptPositions(positions, held, volumeByKey),
  };
}

/** What a receipt token held by the wallet is worth in its underlying coin,
 * read on-chain through its standard interface (ERC-4626 vault, Aave aToken,
 * Compound v3 Comet, Compound v2 cToken — adapters/receiptTokens.ts). */
export interface ReceiptClaim {
  chain: string;
  /** The receipt token's own contract (lowercase). */
  receipt: string;
  /** The coin it stands for (lowercase). */
  asset: string;
  /** The wallet's balance, converted to that coin. */
  assets: number;
}

/** Relative tolerance between the on-chain claim and Zerion's position
 * amount: rounding and a few seconds of accrued yield, never a guess. */
export const RECEIPT_MATCH_TOLERANCE = 0.001;

/**
 * Links a DeFi position to the receipt token the wallet holds for it when
 * Zerion's `pool_contract` doesn't already name a held token — Morpho vaults
 * come with no pool address, Aave's pool address is the lending pool, not the
 * aToken. Same chain, the receipt's underlying coin is the position's coin,
 * and the receipt converts to the position's amount within
 * RECEIPT_MATCH_TOLERANCE. Exactly one claim must match a position, and a
 * claim links at most one position; anything ambiguous stays unlinked (both
 * counted — never dropped on a guess). A linked position gets the receipt as
 * its `pool_contract`, so dedupeReceipts treats it like any receipt.
 */
export function linkReceiptPositions<Pos extends { chain: string | null; contract: string | null; qty: number | null; pool_contract?: string | null }>(
  positions: readonly Pos[],
  claims: readonly ReceiptClaim[],
): Pos[] {
  const receipts = new Set(claims.map((c) => receiptKey(c.chain, c.receipt)));
  const alreadyLinked = (p: Pos) => !!p.chain && !!p.pool_contract && receipts.has(receiptKey(p.chain, p.pool_contract));
  const matches = (p: Pos, c: ReceiptClaim) =>
    !!p.chain &&
    !!p.contract &&
    p.qty !== null &&
    p.qty > 0 &&
    c.chain === p.chain &&
    c.asset === p.contract.toLowerCase() &&
    Math.abs(c.assets - p.qty) <= RECEIPT_MATCH_TOLERANCE * p.qty;
  const open = positions.map((p) => (alreadyLinked(p) ? [] : claims.filter((c) => matches(p, c))));
  const claimUses = new Map<ReceiptClaim, number>();
  for (const cs of open) for (const c of cs) claimUses.set(c, (claimUses.get(c) ?? 0) + 1);
  return positions.map((p, i) => {
    const cs = open[i];
    if (cs.length !== 1 || claimUses.get(cs[0]) !== 1) return p;
    return { ...p, pool_contract: cs[0].receipt };
  });
}

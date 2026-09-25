// Which asset a transaction leg is priced as. A transaction row stores only
// a chain and a ticker (no contract), so it is priced as: that chain's own
// coin when the ticker is the chain's native symbol, else the coin the same
// wallet holds under that ticker on that chain — only when exactly one
// coin matches. Never a price looked up by ticker alone. Pure.

import { resolvePriceKey, type KeyMaps } from "./assetIdentity.ts";

const NO_MAPS: KeyMaps = { registry: new Map(), overrides: new Map(), venues: new Map() };

export const holdingKeyIndex = (holdings: readonly { wallet_id: string; chain: string | null; ticker: string; price_key: string | null }[]) => {
  const index = new Map<string, Set<string>>();
  for (const h of holdings) {
    if (!h.chain || !h.price_key) continue;
    const k = `${h.wallet_id}|${h.chain}|${h.ticker.toUpperCase()}`;
    index.set(k, (index.get(k) ?? new Set()).add(h.price_key));
  }
  return index;
};

export function transactionPriceKey(
  tx: { wallet_id: string; chain: string; ticker: string | null },
  holdingKeys: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  if (!tx.ticker) return null;
  const native = resolvePriceKey({ ticker: tx.ticker, chain: tx.chain, contract: null, source: "auto" }, NO_MAPS);
  if (native) return native;
  const held = holdingKeys.get(`${tx.wallet_id}|${tx.chain}|${tx.ticker.toUpperCase()}`);
  return held && held.size === 1 ? [...held][0] : null;
}

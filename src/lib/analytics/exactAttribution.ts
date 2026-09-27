// Exact attribution: what a wallet was made of at its daily snapshot, and
// how its change since then splits into price moves and quantity changes.
// Pure. (Replaces the 24h-change estimate, which measured prices over the
// last 24 hours while the snapshot could be 39 hours old — 2026-09-27.)
//
// For each coin (price_key): quantity then × (price now − price then) is the
// price effect; (quantity now − quantity then) × price now is a quantity
// change — bought, sold, sent, received. Value held outside a priced coin
// (perp margin, protocol positions) moves with profit, funding and rewards
// and is its own line. A coin still held but no longer valued (unpriced or
// illiquid now) is its own line too, so it's never mistaken for a sale.

import { parseNumeric, valueHolding, type HoldingValuationInput, type PriceMap } from "../valuation.ts";

/** price_key → [quantity, price per unit (null: held but not valued)]. */
export type SnapshotAssets = Record<string, [number, number | null]>;

export interface WalletComposition {
  assets: SnapshotAssets;
  /** Value of holdings not priced by a coin (usd_override rows). */
  positionsUsd: number;
}

type Row = HoldingValuationInput & { price_key?: string | null };

/** What a wallet's holdings are made of, valued exactly as its total is. */
export function walletComposition(holdings: readonly Row[], prices: PriceMap): WalletComposition {
  const assets: SnapshotAssets = {};
  let positionsUsd = 0;
  for (const h of holdings) {
    const v = valueHolding(h, prices);
    const qty = parseNumeric(h.qty);
    const price = h.price_key ? parseNumeric(prices[h.price_key]) : null;
    const byCoin = !!h.price_key && h.source !== "manual_usd" && qty !== null && price !== null;
    if (byCoin && h.price_key) {
      const cur = assets[h.price_key] ?? [0, null];
      // Valued rows carry the price; a held-but-not-valued one (illiquid) keeps null.
      assets[h.price_key] = [cur[0] + qty, v.kind === "priced" ? price : cur[1]];
    } else if (v.kind === "priced") {
      positionsUsd += v.usd;
    } else if (h.price_key && qty !== null) {
      const cur = assets[h.price_key] ?? [0, null];
      assets[h.price_key] = [cur[0] + qty, cur[1]];
    }
  }
  return { assets, positionsUsd };
}

export interface CoinChange {
  key: string;
  qtyBefore: number;
  qtyAfter: number;
  priceBefore: number | null;
  priceNow: number | null;
  /** qtyBefore × (priceNow − priceBefore); 0 when either price is unknown. */
  priceUsd: number;
  /** (qtyAfter − qtyBefore) × the price it's valued at (now, or then when sold out). */
  quantityUsd: number;
  /** Held both times but valued only once (became unpriced/illiquid, or priced again). */
  revaluedUsd: number;
}

export interface ExactChange {
  priceUsd: number;
  quantityUsd: number;
  positionsUsd: number;
  revaluedUsd: number;
  coins: CoinChange[];
}

const valueOf = ([qty, price]: [number, number | null]) => (price === null ? 0 : qty * price);

export function exactChange(before: WalletComposition, now: WalletComposition): ExactChange {
  const coins: CoinChange[] = [];
  for (const key of new Set([...Object.keys(before.assets), ...Object.keys(now.assets)])) {
    const [qB, pB] = before.assets[key] ?? [0, null];
    const [qN, pN] = now.assets[key] ?? [0, null];
    let priceUsd = 0;
    let quantityUsd = 0;
    let revaluedUsd = 0;
    if (pB !== null && pN !== null) {
      priceUsd = qB * (pN - pB);
      quantityUsd = (qN - qB) * pN;
    } else if (pB === null && pN === null) {
      // Not valued either time: no value moved.
    } else if (qB > 0 && qN > 0) {
      // Held both times, valued only once: a valuation change, not a trade.
      const held = Math.min(qB, qN);
      const price = (pN ?? pB) as number;
      revaluedUsd = pN === null ? -held * (pB as number) : held * (pN as number);
      quantityUsd = (qN - qB) * price;
    } else {
      // Bought from nothing, or sold out: valued at the price on the side it exists.
      quantityUsd = valueOf([qN, pN]) - valueOf([qB, pB]);
    }
    coins.push({ key, qtyBefore: qB, qtyAfter: qN, priceBefore: pB, priceNow: pN, priceUsd, quantityUsd, revaluedUsd });
  }
  const sum = (f: (c: CoinChange) => number) => coins.reduce((s, c) => s + f(c), 0);
  return {
    priceUsd: sum((c) => c.priceUsd),
    quantityUsd: sum((c) => c.quantityUsd),
    positionsUsd: now.positionsUsd - before.positionsUsd,
    revaluedUsd: sum((c) => c.revaluedUsd),
    coins: coins.sort((a, b) => Math.abs(b.quantityUsd + b.revaluedUsd) - Math.abs(a.quantityUsd + a.revaluedUsd)),
  };
}

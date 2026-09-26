// A position's take-profit / stop-loss orders, from each venue's own order
// data, in one shape (holdings.position_tpsl). Pure.
//  - Hyperliquid: reduce-only trigger orders (frontendOpenOrders) on the
//    closing side — "Take Profit Market/Limit" → tp, "Stop Market/Limit" → sl;
//    `isPositionTpsl` means the whole position (size null).
//  - Jupiter Perps: the position's tpslRequests (requestType "tp"/"sl"),
//    prices in millionths of a dollar (as Jupiter's own CLI converts them).

export interface TpslOrder {
  kind: "tp" | "sl";
  price: number;
  /** In the position's coin; null = the whole position. */
  size: number | null;
}

export interface HyperliquidOrder {
  coin: string;
  side: "A" | "B"; // A = sell (closes a long), B = buy (closes a short)
  sz: string;
  triggerPx: string;
  isTrigger: boolean;
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType: string;
}

const kindOf = (orderType: string): TpslOrder["kind"] | null =>
  /^take profit/i.test(orderType) ? "tp" : /^stop/i.test(orderType) ? "sl" : null;

/** One position's TP/SL among a market's open orders. */
export function hyperliquidTpsl(orders: readonly HyperliquidOrder[], coin: string, side: "long" | "short"): TpslOrder[] {
  const closing = side === "long" ? "A" : "B";
  const out: TpslOrder[] = [];
  for (const o of orders) {
    if (o.coin !== coin || !o.isTrigger || !o.reduceOnly || o.side !== closing) continue;
    const kind = kindOf(o.orderType);
    const price = Number(o.triggerPx);
    if (!kind || !Number.isFinite(price) || price <= 0) continue;
    const size = Number(o.sz);
    out.push({ kind, price, size: o.isPositionTpsl || !Number.isFinite(size) || size <= 0 ? null : size });
  }
  return out;
}

export interface JupiterTpslRequest {
  requestType: string; // "tp" | "sl"
  triggerPriceUsd: string | null;
  entirePosition: boolean;
  sizeUsd?: string;
}

export function jupiterTpsl(requests: readonly JupiterTpslRequest[]): TpslOrder[] {
  const out: TpslOrder[] = [];
  for (const r of requests) {
    const kind = r.requestType === "tp" || r.requestType === "sl" ? r.requestType : null;
    const price = r.triggerPriceUsd === null ? NaN : Number(r.triggerPriceUsd) / 1e6;
    if (!kind || !Number.isFinite(price) || price <= 0) continue;
    const sizeUsd = Number(r.sizeUsd) / 1e6;
    out.push({ kind, price, size: r.entirePosition || !Number.isFinite(sizeUsd) || sizeUsd <= 0 ? null : sizeUsd / price });
  }
  return out;
}

/** The TP and SL closest to where price is now (or the entry, when there's no
 * mark): for a long, the lowest TP and the highest SL; for a short, the
 * reverse. `more` counts the rest. */
export function nearestTpsl(orders: readonly TpslOrder[], side: "long" | "short"): { tp: number | null; sl: number | null; more: number } {
  const tps = orders.filter((o) => o.kind === "tp").map((o) => o.price);
  const sls = orders.filter((o) => o.kind === "sl").map((o) => o.price);
  const pick = (xs: number[], lowest: boolean) => (xs.length === 0 ? null : lowest ? Math.min(...xs) : Math.max(...xs));
  const tp = pick(tps, side === "long");
  const sl = pick(sls, side === "short");
  return { tp, sl, more: orders.length - (tp !== null ? 1 : 0) - (sl !== null ? 1 : 0) };
}

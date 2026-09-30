// The activity check (docs/wallet-watch/PLAN.md, phase 4): what a watched
// address's transactions since its last full read say it bought, sold or
// moved. Pure — the network half is adapters/watchActivitySources.ts, the
// job watchActivityCheck.ts.
//
// Transactions are reduced to each coin's net change for the address, not
// read by their labels: pump.fun swaps come back "UNKNOWN", and spam drops
// outnumber real trades (7 of 10 watched gem wallets had 95–100+
// transactions a day, 2026-09-28). The day's lines are judged by the daily
// diff's own rule (watchDiff.ts moveKind) against the morning snapshot.

import { MOVE_MIN_USD, moveKind, type MoveKind } from "./watchDiff.ts";

/** One transaction's net change of one coin for the address. */
export interface RawChange {
  txId: string;
  /** ISO time of the transaction. */
  at: string;
  /** Holdings' chain vocabulary: "eth", "base", "solana", "bitcoin", … */
  chain: string;
  /** Token contract / mint; null for the chain's native coin. */
  contract: string | null;
  /** The symbol when the source names it (Alchemy does, Helius doesn't). */
  symbol: string | null;
  qty: number;
  /** The other side of a one-way transfer, when there's a single one. */
  counterparty: string | null;
}

/**
 * - swap: the transaction took one coin out and put another in.
 * - transfer: one way only — received or sent, never called a trade.
 * - unclear: one token out on a chain whose source can't show the native
 *   coin paid back by a router (Alchemy reports internal transfers only on
 *   Ethereum, Base and Polygon, checked 2026-09-28) — sent, or sold.
 */
export type LegKind = "swap" | "transfer" | "unclear";

/** A coin's change in one transaction, as saved on watched_addresses.tx_activity. */
export interface ActivityLeg {
  txId: string;
  /** watchDiff.ts assetOf's key for the coin, so it lines up with the snapshot. */
  assetKey: string;
  sourceChain: string;
  priceKey: string | null;
  ticker: string;
  /** Token contract / mint (null: the native coin). Missing on legs saved
   * before 2026-09-28's copy button. */
  contract?: string | null;
  qtyDelta: number;
  kind: LegKind;
  counterparty: string | null;
  /** Per unit, from the other leg of a swap (SOL, ETH or a stablecoin at
   * today's price); null when it can't be sized. */
  priceUsd: number | null;
  at: string;
  /** When the check that found it ran. */
  checkedAt: string;
  /** Sized at a coin's stored (current) price — a swap with no cash side —
   * rather than at a cash coin's price at the time. */
  sizedBy?: "stored";
  /** Who found it: the live webhook or a Refresh activity check (phase 5 —
   * a check on a live wallet counts what the webhook missed). */
  source?: "webhook" | "check";
}

/** A coin's quantity in the morning snapshot (summed across chains), and
 * whether a row of it was carried forward (not read — never sized). */
export interface ActivityBase {
  qty: number;
  kept: boolean;
}

export interface TxActivity {
  /** The last full read's start: only legs at or after it count. */
  boundary: string;
  legs: ActivityLeg[];
  base: Record<string, ActivityBase>;
}

/** The coins trades are paid in — natives, their wrapped copies and dollar
 * stablecoins. They price the other side of a swap, and moving in and out of
 * them is cash, never a round trip. */
export const CASH_KEYS: ReadonlySet<string> = new Set([
  "solana", "wrapped-solana", "ethereum", "weth", "binancecoin", "wbnb", "matic-network", "polygon-ecosystem-token",
  "avalanche-2", "bitcoin", "usd-coin", "tether", "dai", "usds", "ethena-usde", "first-digital-usd", "paypal-usd", "usd1-wlfi",
  "global-dollar", // USDG — Robinhood Chain's dollar (VirtualBacon pays in it)
]);

/** The dollar coins among them (and a venue's USD balance): moving into or
 * out of these is cash up / cash down — a bearish or bullish call — while
 * SOL or ETH are coins like any other (owner 2026-09-29: "sold SOL, cashed
 * up USDC"). */
export const DOLLAR_KEYS: ReadonlySet<string> = new Set(["usd-coin", "tether", "dai", "usds", "ethena-usde", "first-digital-usd", "paypal-usd", "usd1-wlfi", "global-dollar", "fiat:USD"]);

/** Native SOL moves under this per transaction (rent, fees, tips) without
 * any other coin are not activity. */
export const SOL_DUST = 0.005;

/** A token balance that moved by a few base units in a swap: what a route
 * leaves behind in a coin it passed through, not a trade. As a third leg it
 * kept the real coin from being sized by the SOL paid (Risk's ELON buys,
 * 2026-09-30: 1 unit of SPCX each). Coins with few decimals (whole-unit
 * tokens) are never judged this way. */
export function isRouteResidue(rawUnits: number, decimals: number): boolean {
  return decimals >= 6 && rawUnits !== 0 && Math.abs(rawUnits) <= 10;
}
/** EVM native dust per transaction (gas refunds, tips). */
export const NATIVE_DUST = 0.0001;

export interface LegIdentity {
  assetKey: string;
  priceKey: string | null;
  ticker: string;
}

/**
 * One transaction's changes → legs. `identify` maps a change's coin to the
 * snapshot's key (null: a coin we don't recognize — still counted when
 * deciding whether the transaction was a swap, never saved). `valueOf` is a
 * coin's per-unit USD when it can price the other side of a swap (SOL, ETH,
 * a stablecoin); `noNativeLegs` names chains whose source can't see the
 * native coin a router pays out. `storedValueOf`: a coin's stored price, for
 * a swap with no cash side (BUCKET → STATICS): each coin at its own stored
 * price, or at the other side's when only that one has one — marked
 * `sizedBy: "stored"`.
 */
export function toLegs(
  changes: readonly RawChange[],
  identify: (c: RawChange) => LegIdentity | null,
  valueOf: (priceKey: string | null, at: string) => number | null,
  noNativeLegs: ReadonlySet<string>,
  checkedAt: string,
  storedValueOf?: (priceKey: string | null) => number | null,
): ActivityLeg[] {
  const byTx = new Map<string, RawChange[]>();
  for (const c of changes) byTx.set(c.txId, [...(byTx.get(c.txId) ?? []), c]);
  const out: ActivityLeg[] = [];
  for (const [txId, list] of byTx) {
    // Net per coin within the transaction.
    const net = new Map<string, RawChange>();
    for (const c of list) {
      const k = `${c.chain}|${c.contract?.toLowerCase() ?? "native"}`;
      const cur = net.get(k);
      net.set(k, cur ? { ...cur, qty: cur.qty + c.qty, counterparty: cur.counterparty ?? c.counterparty } : { ...c });
    }
    const moved = [...net.values()].filter((c) => {
      if (c.qty === 0) return false;
      if (c.contract) return true;
      return Math.abs(c.qty) >= (c.chain === "solana" ? SOL_DUST : NATIVE_DUST);
    });
    if (moved.length === 0) continue;
    const swap = moved.some((c) => c.qty > 0) && moved.some((c) => c.qty < 0);
    const identified = moved.map((c) => ({ c, id: identify(c) }));
    // The swap's dollar side: SOL, ETH or a stablecoin leg — or, with no cash
    // side, the coins' stored prices.
    const cashLegs = identified.filter(({ c, id }) => swap && id && valueOf(id.priceKey, c.at) !== null && c.qty !== 0);
    const byStored = swap && cashLegs.length === 0 && !!storedValueOf;
    const price = (k: string | null, at: string) => (byStored ? storedValueOf!(k) : valueOf(k, at));
    const valueLegs = byStored ? identified.filter(({ c, id }) => id && price(id.priceKey, c.at) !== null && c.qty !== 0) : cashLegs;
    for (const { c, id } of identified) {
      if (!id) continue;
      let priceUsd: number | null = price(id.priceKey, c.at);
      if (swap && priceUsd === null) {
        // Priced by the other side, when exactly one coin sits on each side.
        const sameSide = moved.filter((m) => Math.sign(m.qty) === Math.sign(c.qty));
        const other = valueLegs.filter(({ c: v }) => Math.sign(v.qty) !== Math.sign(c.qty));
        if (sameSide.length === 1 && other.length === 1) {
          const v = other[0];
          priceUsd = (Math.abs(v.c.qty) * price(v.id!.priceKey, v.c.at)!) / Math.abs(c.qty);
        }
      }
      const kind: LegKind = swap ? "swap" : c.qty < 0 && c.contract && noNativeLegs.has(c.chain) ? "unclear" : "transfer";
      out.push({
        txId,
        assetKey: id.assetKey,
        sourceChain: c.chain,
        priceKey: id.priceKey,
        ticker: id.ticker,
        contract: c.contract,
        qtyDelta: c.qty,
        kind,
        counterparty: swap ? null : c.counterparty,
        priceUsd,
        ...(byStored && priceUsd !== null ? { sizedBy: "stored" as const } : {}),
        at: c.at,
        checkedAt,
      });
    }
  }
  return out;
}

/** The address's activity after a check: the previous legs still inside the
 * day (a full read since moves the boundary and drops the rest) plus the new
 * ones, each transaction + coin once — appended, never overwritten. */
export function appendLegs(prev: TxActivity | null, boundary: string, legs: readonly ActivityLeg[], base: Record<string, ActivityBase>): TxActivity {
  const since = Date.parse(boundary);
  const kept = prev && prev.boundary === boundary ? prev.legs : (prev?.legs ?? []).filter((l) => Date.parse(l.at) >= since);
  const seen = new Set(kept.map((l) => `${l.txId}|${l.assetKey}`));
  const added = legs.filter((l) => Date.parse(l.at) >= since && !seen.has(`${l.txId}|${l.assetKey}`));
  return { boundary, legs: [...kept, ...added], base: { ...(prev?.boundary === boundary ? prev.base : {}), ...base } };
}

/** A read's hand-off: the legs from before its start are now in the
 * snapshot, so only the ones after it stay (the cursor is untouched). */
export function trimToBoundary(prev: TxActivity | null, boundary: string): TxActivity | null {
  if (!prev) return null;
  const since = Date.parse(boundary);
  return { boundary, legs: prev.legs.filter((l) => Date.parse(l.at) >= since), base: {} };
}

/** The contract / mint an asset key spells out, when it does: Jupiter's
 * `jup:<mint>` and the `<chain>:<contract>` key of a coin without a price
 * key (watchDiff.ts assetOf). Venue keys like `hl:PURR` aren't addresses. */
export function contractFromKey(key: string): string | null {
  const rest = key.startsWith("jup:") ? key.slice(4) : key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
  if (!rest) return null;
  return /^0x[0-9a-fA-F]{40}$/.test(rest) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rest) ? rest : null;
}

/** Bought and then sold within the day: the part sold, at the average buy
 * and sell prices of its swaps. */
export interface RoundTrip {
  qty: number;
  buyPrice: number;
  sellPrice: number;
  pnlUsd: number;
  pnlPct: number;
  firstBuyAt: string;
  lastSellAt: string;
}

/** The price of what's left after the day's trading: for a net buy, the
 * most recent buys covering it (a round trip earlier in the day isn't this
 * position); for a net sale, the most recent sales. Null without a priced swap. */
export function netTradePrice(legs: readonly ActivityLeg[], delta: number): number | null {
  if (delta === 0) return null;
  const side = legs
    .filter((l) => l.kind === "swap" && l.priceUsd !== null && Math.sign(l.qtyDelta) === Math.sign(delta))
    .sort((a, b) => b.at.localeCompare(a.at));
  let need = Math.abs(delta);
  let qty = 0;
  let usd = 0;
  for (const l of side) {
    if (need <= 0) break;
    const take = Math.min(need, Math.abs(l.qtyDelta));
    qty += take;
    usd += take * l.priceUsd!;
    need -= take;
  }
  return qty > 0 ? usd / qty : null;
}

/** A coin's round trip within the day, when it was bought and later sold in
 * priced swaps worth at least MOVE_MIN_USD. */
export function roundTrip(legs: readonly ActivityLeg[]): RoundTrip | null {
  if (legs.some((l) => l.priceKey && CASH_KEYS.has(l.priceKey))) return null; // cash moves, not a trade
  const swaps = legs.filter((l) => l.kind === "swap" && l.priceUsd !== null);
  const buys = swaps.filter((l) => l.qtyDelta > 0);
  if (buys.length === 0) return null;
  const firstBuyAt = buys.map((l) => l.at).sort()[0];
  const sells = swaps.filter((l) => l.qtyDelta < 0 && l.at > firstBuyAt);
  if (sells.length === 0) return null;
  const bought = buys.reduce((s, l) => s + l.qtyDelta, 0);
  const sold = sells.reduce((s, l) => s - l.qtyDelta, 0);
  const buyPrice = buys.reduce((s, l) => s + l.qtyDelta * l.priceUsd!, 0) / bought;
  const sellPrice = sells.reduce((s, l) => s - l.qtyDelta * l.priceUsd!, 0) / sold;
  const qty = Math.min(bought, sold);
  const cost = qty * buyPrice;
  if (Math.max(cost, qty * sellPrice) < MOVE_MIN_USD) return null;
  return { qty, buyPrice, sellPrice, pnlUsd: qty * (sellPrice - buyPrice), pnlPct: (sellPrice / buyPrice - 1) * 100, firstBuyAt, lastSellAt: sells.map((l) => l.at).sort().at(-1)! };
}

export interface DayLine {
  assetKey: string;
  ticker: string;
  /** The token's contract / mint, to copy into a trading app — only when
   * it's a single one (never guessed); null for a native coin. */
  contract: string | null;
  /** The chain that contract is on. */
  contractChain: string | null;
  priceKey: string | null;
  /** A net change since the morning, or a round trip: bought and sold
   * within the day (owner 2026-09-28: a flip at a loss is worth seeing). */
  kind: MoveKind | "roundtrip";
  /** Set on a round trip. */
  roundTrip?: RoundTrip;
  /** How it happened: trades, plain transfers, both, or unclear. */
  via: "swap" | "transfer" | "mixed" | "unclear";
  qtyBefore: number;
  qtyAfter: number;
  /** At the price now (or the trade's price when the coin has none yet). */
  usdDelta: number;
  /** Average price of its swaps, weighted by quantity; null without one. */
  tradePrice: number | null;
  lastAt: string;
  /** The earliest check that found any of it ("new since your last look"). */
  firstCheckedAt: string;
}

/**
 * One influencer's day: its addresses' legs since each one's boundary, net
 * per coin, against the morning quantities — the daily diff's rule.
 * Transfers between two of its own addresses cancel out. `priceNow` is the
 * coin's stored price (null when it has none: the trade's price is used).
 */
export function dayLines(activities: readonly TxActivity[], ownAddresses: ReadonlySet<string>, priceNow: (priceKey: string | null) => number | null): DayLine[] {
  const base = new Map<string, ActivityBase>();
  for (const a of activities) {
    for (const [k, b] of Object.entries(a.base)) {
      const cur = base.get(k);
      base.set(k, cur ? { qty: cur.qty + b.qty, kept: cur.kept || b.kept } : { ...b });
    }
  }
  const own = new Set([...ownAddresses].map((a) => a.toLowerCase()));
  const byKey = new Map<string, ActivityLeg[]>();
  for (const a of activities) {
    const since = Date.parse(a.boundary);
    for (const l of a.legs) {
      if (Date.parse(l.at) < since) continue;
      if (l.kind === "transfer" && l.counterparty && own.has(l.counterparty.toLowerCase())) continue;
      byKey.set(l.assetKey, [...(byKey.get(l.assetKey) ?? []), l]);
    }
  }
  const out: DayLine[] = [];
  for (const [key, legs] of byKey) {
    const b = base.get(key) ?? { qty: 0, kept: false };
    if (b.kept) continue; // this morning's quantity wasn't read
    const contracts = [...new Set(legs.map((l) => l.contract ?? contractFromKey(l.assetKey)).filter((c): c is string => !!c))];
    const chains = [...new Set(legs.filter((l) => l.contract ?? contractFromKey(l.assetKey)).map((l) => l.sourceChain))];
    const common = {
      assetKey: key,
      ticker: legs[0].ticker,
      contract: contracts.length === 1 ? contracts[0] : null,
      contractChain: contracts.length === 1 && chains.length === 1 ? chains[0] : null,
      priceKey: legs[0].priceKey,
      firstCheckedAt: legs.map((l) => l.checkedAt).sort()[0],
    };
    const trip = roundTrip(legs);
    if (trip) out.push({ ...common, kind: "roundtrip", via: "swap", qtyBefore: 0, qtyAfter: 0, usdDelta: trip.pnlUsd, tradePrice: trip.buyPrice, lastAt: trip.lastSellAt, roundTrip: trip });

    // The net change since the morning (what's left after any round trip).
    const delta = legs.reduce((s, l) => s + l.qtyDelta, 0);
    const tradePrice = netTradePrice(legs, delta);
    const price = priceNow(legs[0].priceKey) ?? tradePrice;
    if (price === null) continue; // can't be sized — like the daily diff
    const qtyAfter = b.qty + delta;
    const kind = moveKind(b.qty, qtyAfter, price);
    if (!kind) continue;
    const kinds = new Set(legs.map((l) => l.kind));
    const via = kinds.size > 1 ? (kinds.has("unclear") && !kinds.has("swap") ? "unclear" : "mixed") : [...kinds][0];
    out.push({ ...common, kind, via, qtyBefore: b.qty, qtyAfter, usdDelta: delta * price, tradePrice, lastAt: legs.map((l) => l.at).sort().at(-1)! });
  }
  return out.sort((x, y) => y.lastAt.localeCompare(x.lastAt));
}

/** One trade of a coin within the day: a buy or sale (with what was paid or
 * received — SOL, USDC, ETH — from the same transaction), or a plain transfer. */
export interface CoinTrade {
  txId: string;
  at: string;
  side: "buy" | "sell" | "received" | "sent";
  qty: number;
  /** The cash side of a swap: amount and ticker; null for a transfer or a
   * coin-for-coin swap. */
  payQty: number | null;
  payTicker: string | null;
  /** The trade's value at its own price; null when it can't be sized. */
  usd: number | null;
  source: "webhook" | "check";
}

/** A coin's day, like a trading app's per-token card (owner 2026-09-28:
 * "on kolscan it shows 1 buy 1 sell, multiple buys and a sell"): every trade,
 * the totals, what's still held, and what the sold part made. Cash coins
 * (SOL, USDC, ETH) aren't coins here — they're the payment side of trades. */
export interface CoinDay {
  assetKey: string;
  ticker: string;
  contract: string | null;
  contractChain: string | null;
  priceKey: string | null;
  /** Newest first. */
  trades: CoinTrade[];
  buys: number;
  sells: number;
  boughtQty: number;
  soldQty: number;
  boughtUsd: number | null;
  soldUsd: number | null;
  /** SOL/USDC spent and received, when every trade was paid in one of them. */
  boughtPay: number | null;
  soldPay: number | null;
  payTicker: string | null;
  /** What was held at the morning read and what's held now (morning + today). */
  heldBefore: number;
  holdingQty: number;
  /** For the part sold that was also bought today: proceeds minus its cost,
   * and that as a %. Null when nothing bought today was sold. */
  realizedUsd: number | null;
  realizedPct: number | null;
  /** Some of what was sold was held before today (its cost isn't known here). */
  soldFromEarlier: boolean;
  /** Average price paid across today's buys, and received across today's sales. */
  avgEntryUsd: number | null;
  avgExitUsd: number | null;
  /** With no buys today: the share of the morning position sold (0–1). */
  soldShareOfPosition: number | null;
  firstAt: string;
  lastAt: string;
  firstCheckedAt: string;
}

/** Per coin, one influencer's day (its addresses' legs since each boundary);
 * transfers between its own addresses cancel out, cash coins are left out,
 * and a coin needs at least MOVE_MIN_USD of trading to show. */
export function coinDays(activities: readonly TxActivity[], ownAddresses: ReadonlySet<string>): CoinDay[] {
  const own = new Set([...ownAddresses].map((a) => a.toLowerCase()));
  const base = new Map<string, number>();
  const legsByTx = new Map<string, ActivityLeg[]>();
  const coinLegs = new Map<string, ActivityLeg[]>();
  for (const a of activities) {
    for (const [k, b] of Object.entries(a.base)) base.set(k, (base.get(k) ?? 0) + b.qty);
    const since = Date.parse(a.boundary);
    for (const l of a.legs) {
      if (Date.parse(l.at) < since) continue;
      legsByTx.set(l.txId, [...(legsByTx.get(l.txId) ?? []), l]);
      if (l.priceKey && CASH_KEYS.has(l.priceKey)) continue;
      if (l.kind === "transfer" && l.counterparty && own.has(l.counterparty.toLowerCase())) continue;
      coinLegs.set(l.assetKey, [...(coinLegs.get(l.assetKey) ?? []), l]);
    }
  }
  const out: CoinDay[] = [];
  for (const [key, legs] of coinLegs) {
    const trades: CoinTrade[] = legs.map((l) => {
      const cash = (legsByTx.get(l.txId) ?? []).find((o) => o !== l && o.priceKey && CASH_KEYS.has(o.priceKey) && Math.sign(o.qtyDelta) !== Math.sign(l.qtyDelta));
      const side: CoinTrade["side"] = l.kind === "swap" ? (l.qtyDelta > 0 ? "buy" : "sell") : l.qtyDelta > 0 ? "received" : "sent";
      return {
        txId: l.txId,
        at: l.at,
        side,
        qty: Math.abs(l.qtyDelta),
        payQty: cash ? Math.abs(cash.qtyDelta) : null,
        payTicker: cash ? cash.ticker : null,
        usd: l.priceUsd !== null ? Math.abs(l.qtyDelta) * l.priceUsd : null,
        source: l.source ?? "check",
      };
    });
    trades.sort((a, b) => b.at.localeCompare(a.at));
    const buys = trades.filter((t) => t.side === "buy");
    const sells = trades.filter((t) => t.side === "sell");
    const sum = (ts: CoinTrade[], f: (t: CoinTrade) => number | null) => (ts.length === 0 ? 0 : ts.every((t) => f(t) !== null) ? ts.reduce((s, t) => s + f(t)!, 0) : null);
    const boughtQty = buys.reduce((s, t) => s + t.qty, 0);
    const soldQty = sells.reduce((s, t) => s + t.qty, 0);
    const boughtUsd = sum(buys, (t) => t.usd);
    const soldUsd = sum(sells, (t) => t.usd);
    const payTickers = new Set([...buys, ...sells].map((t) => t.payTicker));
    const onePay = payTickers.size === 1 && !payTickers.has(null) ? [...payTickers][0] : null;
    const heldBefore = base.get(key) ?? 0;
    // What sold today that was also bought today (the rest came from earlier holdings).
    const matched = Math.min(boughtQty, soldQty);
    const realizedUsd = matched > 0 && boughtUsd !== null && soldUsd !== null && boughtQty > 0 && soldQty > 0 ? matched * (soldUsd / soldQty - boughtUsd / boughtQty) : null;
    const size = Math.max(boughtUsd ?? 0, soldUsd ?? 0, ...trades.map((t) => t.usd ?? 0));
    if (size < MOVE_MIN_USD) continue;
    const avgEntryUsd = boughtUsd !== null && boughtQty > 0 ? boughtUsd / boughtQty : null;
    const avgExitUsd = soldUsd !== null && soldQty > 0 ? soldUsd / soldQty : null;
    const netQty = legs.reduce((s, l) => s + l.qtyDelta, 0);
    // Nothing bought today: only trimming or adding to what was already held —
    // the daily read's bar (≥ 1% of the position or ≥ $5,000) keeps it quiet.
    if (buys.length === 0) {
      const price = avgExitUsd ?? (trades.find((t) => t.usd !== null && t.qty > 0) ? trades.find((t) => t.usd !== null)!.usd! / trades.find((t) => t.usd !== null)!.qty : null);
      if (price === null || !moveKind(heldBefore, Math.max(0, heldBefore + netQty), price)) continue;
    }
    const first = legs.reduce((a, l) => (l.at < a.at ? l : a));
    out.push({
      assetKey: key,
      ticker: first.ticker,
      contract: legs.map((l) => l.contract ?? contractFromKey(l.assetKey)).find((c): c is string => !!c) ?? null,
      contractChain: legs.find((l) => l.contract ?? contractFromKey(l.assetKey))?.sourceChain ?? null,
      priceKey: first.priceKey,
      trades,
      buys: buys.length,
      sells: sells.length,
      boughtQty,
      soldQty,
      boughtUsd,
      soldUsd,
      boughtPay: onePay ? buys.reduce((s, t) => s + (t.payQty ?? 0), 0) : null,
      soldPay: onePay ? sells.reduce((s, t) => s + (t.payQty ?? 0), 0) : null,
      payTicker: onePay,
      heldBefore,
      holdingQty: Math.max(0, heldBefore + legs.reduce((s, l) => s + l.qtyDelta, 0)),
      realizedUsd,
      realizedPct: realizedUsd !== null && boughtUsd ? (realizedUsd / (matched * (boughtUsd / boughtQty))) * 100 : null,
      soldFromEarlier: soldQty > boughtQty + 1e-9,
      avgEntryUsd,
      avgExitUsd,
      soldShareOfPosition: buys.length === 0 && heldBefore > 0 && soldQty > 0 ? Math.min(1, soldQty / heldBefore) : null,
      firstAt: trades.at(-1)!.at,
      lastAt: trades[0].at,
      firstCheckedAt: legs.map((l) => l.checkedAt).sort()[0],
    });
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** The most recent daily read time (08:00 UTC, the cron) at or before now. */
export function todaysReadTime(nowMs: number, readHourUtc = 8): number {
  const d = new Date(nowMs);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), readHourUtc);
  return t <= nowMs ? t : t - 86_400_000;
}

/**
 * "Since this morning's read" never reaches back past this morning (owner
 * 2026-09-29: yesterday's trades stayed when the morning read didn't get to
 * an address). A day whose read didn't happen starts at the read's time
 * instead: the legs before it are left out, and each coin's starting
 * quantity moves forward by them, so holdings stay right. Nothing is deleted
 * — the read, when it happens, still records those trades as movements. Pure.
 */
export function rebaseToDay(activity: TxActivity, dayStartMs: number): TxActivity {
  if (Date.parse(activity.boundary) >= dayStartMs) return activity;
  const base: Record<string, ActivityBase> = { ...activity.base };
  const kept: ActivityLeg[] = [];
  for (const l of activity.legs) {
    if (Date.parse(l.at) >= dayStartMs) {
      kept.push(l);
      continue;
    }
    const b = base[l.assetKey] ?? { qty: 0, kept: false };
    base[l.assetKey] = { ...b, qty: b.qty + l.qtyDelta };
  }
  return { boundary: new Date(dayStartMs).toISOString(), legs: kept, base };
}

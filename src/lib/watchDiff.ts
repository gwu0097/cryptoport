// Wallet Watch movements (docs/wallet-watch/PLAN.md, phase 2): what changed
// between two reads of an address. Pure.
//
// Only a change in QUANTITY is a movement — never a price move, and never a
// row changing class (a token losing its price today, dipping under the dust
// floor, or turning illiquid keeps its quantity in the snapshot and so
// produces nothing). A row carried forward from the last read because its
// source failed (`kept`) never produces one either.
//
// What is compared, per asset (`assetKey`):
// - a coin: its price key, quantity summed across chains — USDC on Base and
//   on Arbitrum is one asset, so bridging isn't a movement. A receipt valued
//   as its underlying ("hUSDB (as USDB)") keeps its own contract as its key,
//   so it never merges with the coin it's priced as. A token with no price
//   key: chain + contract.
// - a perp position: venue + market + side, by size (never margin, which
//   moves with PnL).
// - a prediction share: its market outcome, by number of shares.
// Not compared: venue cash (Hyperliquid/Lighter/Aster account balances move
// with PnL and funding every day) and other protocol positions valued as a
// whole (LP, vaults: their value moves with price).

import type { SnapshotRow, WatchSnapshot } from "./watchSnapshot.ts";

/** A change must be at least this share of the previous quantity … */
export const MOVE_MIN_SHARE = 0.05;
/** … and at least this many dollars at today's price. */
export const MOVE_MIN_USD = 100;

export type PositionType = "token" | "perp" | "prediction";
export type MoveKind = "new" | "added" | "trimmed" | "exited";

export interface AssetState {
  key: string;
  type: PositionType;
  ticker: string;
  label: string | null;
  priceKey: string | null;
  side: string | null;
  qty: number;
  /** A row in it was carried forward from the last read. */
  kept: boolean;
}

export interface Movement {
  assetKey: string;
  kind: MoveKind;
  positionType: PositionType;
  ticker: string;
  label: string | null;
  priceKey: string | null;
  side: string | null;
  qtyBefore: number;
  qtyAfter: number;
  /** Per unit, at this read; null when unknown (unknown is never 0). */
  priceUsd: number | null;
  usdDelta: number | null;
}

const VENUE_CASH_CHAINS = new Set(["hyperliquid", "lighter", "aster"]);

/** The asset a stored row belongs to, or null when rows like it are never
 * compared. */
export function assetOf(r: SnapshotRow): Omit<AssetState, "qty" | "kept"> | null {
  if (r.qty == null) return null;
  if (r.position_side) {
    return { key: `perp:${r.chain ?? ""}:${r.ticker}:${r.position_side}`, type: "perp", ticker: r.ticker, label: r.display_label ?? null, priceKey: null, side: r.position_side };
  }
  if (r.chain === "polymarket" || r.ticker.startsWith("POLY-")) {
    return { key: `prediction:${r.ticker}`, type: "prediction", ticker: r.ticker, label: r.display_label ?? null, priceKey: null, side: null };
  }
  if (r.chain && VENUE_CASH_CHAINS.has(r.chain) && r.usd_override != null) return null; // venue cash
  if (r.category !== "token") return null; // positions valued as a whole
  const isReceipt = !!r.display_label && r.display_label.includes("(as ");
  const key = r.price_key && !isReceipt ? r.price_key : r.contract ? `${r.chain ?? ""}:${r.contract.toLowerCase()}` : r.price_key ? r.price_key : null;
  if (!key) return null;
  return { key, type: "token", ticker: r.ticker, label: r.display_label ?? null, priceKey: r.price_key ?? null, side: null };
}

/** Every compared asset in a snapshot, quantities summed. Unrecognized
 * tokens the snapshot kept (stored before, unpriced today) count with their
 * amount under their chain + contract key — and under the price key they had
 * before, when the previous snapshot names one. */
export function assetStates(snapshot: WatchSnapshot | null, previousKeyOf?: ReadonlyMap<string, string>): Map<string, AssetState> {
  const out = new Map<string, AssetState>();
  const add = (base: Omit<AssetState, "qty" | "kept">, qty: number, kept: boolean) => {
    const cur = out.get(base.key);
    if (cur) {
      cur.qty += qty;
      cur.kept ||= kept;
    } else out.set(base.key, { ...base, qty, kept });
  };
  for (const r of snapshot?.rows ?? []) {
    const a = assetOf(r);
    if (a) add(a, r.qty ?? 0, !!r.kept);
  }
  for (const u of snapshot?.unrecognized ?? []) {
    if (u.amount === null) continue;
    const contractKey = `${u.chain}:${u.contract.toLowerCase()}`;
    const key = previousKeyOf?.get(contractKey) ?? contractKey;
    add({ key, type: "token", ticker: u.symbol, label: null, priceKey: previousKeyOf?.get(contractKey) ?? null, side: null }, u.amount, false);
  }
  return out;
}

/** chain:contract → the price key it was compared under, for a snapshot. */
export function contractKeys(snapshot: WatchSnapshot | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of snapshot?.rows ?? []) {
    const a = assetOf(r);
    if (a && r.contract && a.type === "token") out.set(`${r.chain ?? ""}:${r.contract.toLowerCase()}`, a.key);
  }
  return out;
}

/**
 * The movements from `before` to `after`. `priceOf` is an asset's per-unit
 * dollar price at this read (null when unknown or illiquid): a change without
 * a price can't be sized, so it isn't reported.
 */
export function diffSnapshots(
  before: WatchSnapshot | null,
  after: WatchSnapshot,
  priceOf: (asset: AssetState) => number | null,
): Movement[] {
  if (!before) return []; // the first read has nothing to compare with
  const prev = assetStates(before);
  const next = assetStates(after, contractKeys(before));
  const out: Movement[] = [];
  for (const key of new Set([...prev.keys(), ...next.keys()])) {
    const a = prev.get(key);
    const b = next.get(key);
    if (b?.kept) continue; // not read this time
    const qtyBefore = a?.qty ?? 0;
    const qtyAfter = b?.qty ?? 0;
    const delta = qtyAfter - qtyBefore;
    if (delta === 0) continue;
    const state = (b ?? a)!;
    const price = priceOf(state);
    if (price === null) continue;
    const usd = delta * price;
    if (Math.abs(usd) < MOVE_MIN_USD) continue;
    if (qtyBefore > 0 && Math.abs(delta) < MOVE_MIN_SHARE * qtyBefore) continue;
    // What's left worth under a dollar is a closed position, not a trim.
    const closed = qtyAfter <= 0 || qtyAfter * price < 1;
    const kind: MoveKind = qtyBefore <= 0 ? "new" : closed ? "exited" : delta > 0 ? "added" : "trimmed";
    out.push({
      assetKey: key,
      kind,
      positionType: state.type,
      ticker: state.ticker,
      label: state.label,
      priceKey: state.priceKey,
      side: state.side,
      qtyBefore,
      qtyAfter,
      priceUsd: price,
      usdDelta: usd,
    });
  }
  return out.sort((x, y) => Math.abs(y.usdDelta ?? 0) - Math.abs(x.usdDelta ?? 0));
}

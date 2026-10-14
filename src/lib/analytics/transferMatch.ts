// Where a coin that went down went: matched from the wallet's stored
// transaction history (`transactions`, written by the transaction sync).
// Pure. Plan: docs/analytics/WHERE_IT_WENT.md.
//
// Each out-leg of the coin inside the window is explained by the first rule
// that fits, the way Zerion, DeBank and CoinTracker classify transfers:
//   1. the same transaction (same wallet and chain) has an in-leg of another
//      coin → a trade ("→ 0.0168 ETH");
//   2. the other address is one of the user's own wallets → a move;
//   3. an in-leg of another coin lands in the same wallet, on any chain, from
//      a minute before to 10 minutes after, worth within 10% → a cross-chain
//      swap or bridge ("→ 342 USDC on Arbitrum"). The minute before allows
//      for two chains' block clocks disagreeing; both legs must be valued
//      from stored prices, else no match;
//   4. the other address is a known destination (knownDestinations.ts);
//   5. otherwise it was sent to an outside address.
// What the history can't explain is "unknown" — the wallet's history isn't
// synced over the window, or the out-legs found add up to less than the
// drop. Never a guess.
//
// Coins are linked to transaction rows by ticker, case-insensitively: rows
// carry the token's symbol and no price_key, so the symbol is the best
// stored link. A coin whose symbol isn't known can't be matched (unknown).
//
// One hop is followed, only when it's plain: a trade's or swap's proceeds
// sent on from the same wallet and chain to a known destination, at least
// the amount received ("→ 342 USDC on Arbitrum → Hyperliquid").

import { knownDestination } from "./knownDestinations.ts";

export interface TxLeg {
  walletId: string;
  chain: string;
  txHash: string;
  /** ISO time. */
  occurredAt: string;
  /** 'in' | 'out' | 'self' | 'unknown' — only in and out are used. */
  direction: string;
  ticker: string | null;
  amount: number | null;
  /** The other address (lowercase for EVM); null when the source has none (Solana). */
  counterparty: string | null;
}

export interface MatchWallet {
  id: string;
  name: string;
  address: string | null;
  /** When its transaction history was last synced (ISO); null = never. */
  txSyncedAt: string | null;
}

/** A coin whose quantity went down in a wallet over the window. */
export interface DroppedCoin {
  walletId: string;
  /** The coin's price_key — the result's key. */
  key: string;
  /** Its ticker, as transaction rows name it; null when unknown. */
  symbol: string | null;
  /** How much the quantity went down (> 0). */
  drop: number;
  /** The price it's valued at (the snapshot's, else now); null = unknown. */
  unitPrice: number | null;
}

export interface Proceeds {
  ticker: string;
  amount: number;
  chain: string;
  /** Where the proceeds went next (one hop, a known destination). */
  then?: string;
}

export type Destination =
  | { kind: "trade"; amount: number; into: Proceeds[] }
  | { kind: "moved"; amount: number; toWalletId: string; toWalletName: string }
  | { kind: "crossChainSwap"; amount: number; into: Proceeds }
  | { kind: "destination"; amount: number; label: string }
  /** `to`: the shortened outside address; null when the row names none. */
  | { kind: "sent"; amount: number; to: string | null }
  /** `reason`: "not-synced" — the history doesn't cover the window;
   * "not-found" — no transaction explains this much of the drop. */
  | { kind: "unknown"; amount: number; reason: "not-synced" | "not-found" };

export interface WalletMove {
  fromWalletId: string;
  fromWalletName: string;
  toWalletId: string;
  toWalletName: string;
  ticker: string;
  amount: number;
  /** null when the coin's price is unknown. */
  usd: number | null;
}

export interface MatchInput {
  legs: readonly TxLeg[];
  wallets: readonly MatchWallet[];
  /** Per wallet, when its window starts (its base snapshot's time, ISO). */
  since: ReadonlyMap<string, string>;
  coins: readonly DroppedCoin[];
  /** A unit price for a ticker from the user's own stored prices; null when
   * unknown or ambiguous. */
  priceOf: (ticker: string) => number | null;
  /** Set when the read was capped: rows are complete only from this time. */
  coveredFrom?: string | null;
}

export interface MatchResult {
  /** `${walletId}|${key}` → its destinations, largest first. */
  byCoin: Map<string, Destination[]>;
  moves: WalletMove[];
}

const CROSS_CHAIN_AFTER_MS = 10 * 60_000;
const CROSS_CHAIN_BEFORE_MS = 60_000;
const CROSS_CHAIN_VALUE_TOLERANCE = 0.1;
/** Out-legs this much short of the drop leave the rest unknown. */
const REMAINDER_SHARE = 0.01;

export const coinKey = (walletId: string, key: string) => `${walletId}|${key}`;
const up = (s: string | null) => (s ?? "").toUpperCase();
const ms = (iso: string) => Date.parse(iso);
const legId = (l: TxLeg) => `${l.walletId}|${l.chain}|${l.txHash}|${up(l.ticker)}|${l.direction}|${l.amount}`;

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Tickers worth naming (their price_keys) for matching: every out-leg's, and
 * the in-legs that could be the other side of a cross-chain swap. */
export function tickersToName(legs: readonly TxLeg[]): string[] {
  const outs = legs.filter((l) => l.direction === "out" && l.ticker);
  const out = new Set(outs.map((l) => up(l.ticker)));
  for (const l of legs) {
    if (l.direction !== "in" || !l.ticker) continue;
    const t = ms(l.occurredAt);
    if (outs.some((o) => o.walletId === l.walletId && t >= ms(o.occurredAt) - CROSS_CHAIN_BEFORE_MS && t <= ms(o.occurredAt) + CROSS_CHAIN_AFTER_MS)) out.add(up(l.ticker));
  }
  return [...out].sort();
}

export function matchDestinations(input: MatchInput): MatchResult {
  const walletById = new Map(input.wallets.map((w) => [w.id, w]));
  const walletByAddress = new Map<string, MatchWallet>();
  for (const w of input.wallets) if (w.address && !walletByAddress.has(w.address.toLowerCase())) walletByAddress.set(w.address.toLowerCase(), w);
  const legsOf = new Map<string, TxLeg[]>();
  for (const l of input.legs) legsOf.set(l.walletId, [...(legsOf.get(l.walletId) ?? []), l]);
  // An in-leg used as one swap's other side isn't used again.
  const used = new Set<string>();
  const byCoin = new Map<string, Destination[]>();
  const moves = new Map<string, WalletMove>();

  // Larger drops claim cross-chain arrivals first.
  const coins = [...input.coins].sort((a, b) => b.drop * (b.unitPrice ?? 0) - a.drop * (a.unitPrice ?? 0));
  for (const coin of coins) {
    const wallet = walletById.get(coin.walletId);
    const since = input.since.get(coin.walletId);
    const covered =
      !!wallet && !!since && !!wallet.txSyncedAt && ms(wallet.txSyncedAt) >= ms(since) && (!input.coveredFrom || ms(input.coveredFrom) <= ms(since));
    if (!wallet || !since || !covered) {
      byCoin.set(coinKey(coin.walletId, coin.key), [{ kind: "unknown", amount: coin.drop, reason: "not-synced" }]);
      continue;
    }
    const legs = (legsOf.get(wallet.id) ?? []).filter((l) => ms(l.occurredAt) >= ms(since));
    const sym = up(coin.symbol);
    const outs = sym ? legs.filter((l) => l.direction === "out" && up(l.ticker) === sym && (l.amount ?? 0) > 0).sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt)) : [];
    const found: Destination[] = [];
    for (const out of outs) {
      const amount = out.amount as number;
      const d = classify(out, amount, sym, coin, wallet, legs, input, walletByAddress, used);
      found.push(d);
      if (d.kind === "moved") {
        const k = `${wallet.id}|${d.toWalletId}|${sym}`;
        const usd = coin.unitPrice === null ? null : amount * coin.unitPrice;
        const cur = moves.get(k);
        if (cur) {
          cur.amount += amount;
          cur.usd = cur.usd === null || usd === null ? null : cur.usd + usd;
        } else moves.set(k, { fromWalletId: wallet.id, fromWalletName: wallet.name, toWalletId: d.toWalletId, toWalletName: d.toWalletName, ticker: out.ticker ?? sym, amount, usd });
      }
    }
    const explained = found.reduce((s, d) => s + d.amount, 0);
    const rest = coin.drop - explained;
    if (rest > coin.drop * REMAINDER_SHARE) found.push({ kind: "unknown", amount: rest, reason: "not-found" });
    byCoin.set(coinKey(coin.walletId, coin.key), merge(found));
  }
  return { byCoin, moves: [...moves.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)) };
}

function classify(
  out: TxLeg,
  amount: number,
  sym: string,
  coin: DroppedCoin,
  wallet: MatchWallet,
  legs: readonly TxLeg[],
  input: MatchInput,
  walletByAddress: ReadonlyMap<string, MatchWallet>,
  used: Set<string>,
): Destination {
  const t = ms(out.occurredAt);
  // 1. The same transaction brought another coin in: a trade. (A swap's
  // legs both name the router as the other address, so this comes first.)
  const ins = legs.filter((l) => l.txHash === out.txHash && l.chain === out.chain && l.direction === "in" && up(l.ticker) !== sym && (l.amount ?? 0) > 0);
  if (ins.length > 0) {
    return { kind: "trade", amount, into: ins.map((l) => withNextHop({ ticker: l.ticker as string, amount: l.amount as number, chain: l.chain }, l, legs)) };
  }
  // 2. Sent to another of the user's own wallets.
  const cp = out.counterparty?.toLowerCase() ?? null;
  const own = cp ? walletByAddress.get(cp) : undefined;
  if (own && own.id !== wallet.id) return { kind: "moved", amount, toWalletId: own.id, toWalletName: own.name };
  // 3. Another coin arrived in the same wallet minutes later, worth about the
  // same: a cross-chain swap or bridge.
  if (coin.unitPrice !== null) {
    const outUsd = amount * coin.unitPrice;
    const txWithOut = new Set(legs.filter((l) => l.direction === "out").map((l) => `${l.chain}|${l.txHash}`));
    let best: { leg: TxLeg; gap: number } | null = null;
    for (const l of legs) {
      if (l.direction !== "in" || !l.ticker || up(l.ticker) === sym || l.txHash === out.txHash || (l.amount ?? 0) <= 0) continue;
      // An arrival from a trade of its own isn't the other side of a bridge.
      if (txWithOut.has(`${l.chain}|${l.txHash}`) || used.has(legId(l))) continue;
      const lt = ms(l.occurredAt);
      if (lt < t - CROSS_CHAIN_BEFORE_MS || lt > t + CROSS_CHAIN_AFTER_MS) continue;
      const price = input.priceOf(l.ticker);
      if (price === null) continue;
      const gap = Math.abs((l.amount as number) * price - outUsd);
      if (gap <= CROSS_CHAIN_VALUE_TOLERANCE * outUsd && (!best || gap < best.gap)) best = { leg: l, gap };
    }
    if (best) {
      used.add(legId(best.leg));
      return { kind: "crossChainSwap", amount, into: withNextHop({ ticker: best.leg.ticker as string, amount: best.leg.amount as number, chain: best.leg.chain }, best.leg, legs) };
    }
  }
  // 4. A known destination.
  const label = knownDestination(cp);
  if (label) return { kind: "destination", amount, label };
  // 5. An outside address.
  return { kind: "sent", amount, to: cp ? shortAddress(cp) : null };
}

/** The proceeds sent on, whole, from the same wallet and chain to a known
 * destination after they arrived. One hop only. */
function withNextHop(p: Proceeds, arrival: TxLeg, legs: readonly TxLeg[]): Proceeds {
  const next = legs.find(
    (l) =>
      l.direction === "out" &&
      l.chain === p.chain &&
      up(l.ticker) === up(p.ticker) &&
      ms(l.occurredAt) >= ms(arrival.occurredAt) &&
      (l.amount ?? 0) >= p.amount * 0.999 &&
      knownDestination(l.counterparty) !== null,
  );
  return next ? { ...p, then: knownDestination(next.counterparty) as string } : p;
}

/** Same place, one line (amounts summed); trades stay one per transaction.
 * Largest first. */
function merge(found: readonly Destination[]): Destination[] {
  const out: Destination[] = [];
  const at = new Map<string, Destination>();
  for (const d of found) {
    const k =
      d.kind === "moved" ? `m|${d.toWalletId}` : d.kind === "destination" ? `d|${d.label}` : d.kind === "sent" ? `s|${d.to}` : d.kind === "unknown" ? `u|${d.reason}` : null;
    const cur = k ? at.get(k) : undefined;
    if (cur) cur.amount += d.amount;
    else {
      const copy = { ...d };
      out.push(copy);
      if (k) at.set(k, copy);
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
}

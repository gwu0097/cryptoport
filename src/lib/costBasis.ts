// A holding's cost basis from its history (owner 2026-10-14: "if the cost
// basis is available, put it in the token drawer"). Pure. An estimate for "how
// am I doing on this", not a tax lot record (CLAUDE.md §1: not a tax tool).
//
// Average cost, in time order: a buy adds its quantity and what was paid
// (valued when it was paid); a sale or transfer out takes its share out of
// the pool at the average cost, leaving the average unchanged. Coins that came
// in without a payment the reader could see (a transfer from another wallet,
// an airdrop, a payment in a coin with no close that day) form a separate
// "cost unknown" pool — never treated as free, so the average is only ever
// what was really paid.

export interface CostEvent {
  /** ISO time. */
  at: string;
  /** Signed: + in, − out. */
  qty: number;
  /** For an in: what was paid, in dollars; null = unknown (not free). */
  paidUsd: number | null;
}

export interface CostBasis {
  /** Average paid per coin over the costed part; null when nothing was costed. */
  avgCost: number | null;
  /** What the costed part of today's holding cost. */
  costUsd: number | null;
  /** Coins in the holding with a known cost / with none. */
  costedQty: number;
  unknownQty: number;
  buys: number;
  firstBuyAt: string | null;
}

export function averageCost(events: readonly CostEvent[]): CostBasis {
  let qtyC = 0;
  let costC = 0;
  let qtyU = 0;
  let buys = 0;
  let firstBuyAt: string | null = null;
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!(Math.abs(e.qty) > 0)) continue;
    if (e.qty > 0) {
      if (e.paidUsd !== null && e.paidUsd >= 0) {
        qtyC += e.qty;
        costC += e.paidUsd;
        buys++;
        firstBuyAt ??= e.at;
      } else {
        qtyU += e.qty;
      }
      continue;
    }
    // Out: from both pools in proportion, each at its own average.
    const total = qtyC + qtyU;
    if (total <= 0) continue;
    const out = Math.min(-e.qty, total);
    const fromC = out * (qtyC / total);
    const avg = qtyC > 0 ? costC / qtyC : 0;
    costC -= avg * fromC;
    qtyC -= fromC;
    qtyU -= out - fromC;
  }
  const tiny = (x: number) => (Math.abs(x) < 1e-12 ? 0 : x);
  qtyC = tiny(qtyC);
  qtyU = tiny(qtyU);
  return { avgCost: qtyC > 0 ? costC / qtyC : null, costUsd: qtyC > 0 ? costC : null, costedQty: qtyC, unknownQty: qtyU, buys, firstBuyAt };
}

/** A movement as read, with what was paid in base units (the reader's shape). */
export interface PaidEvent {
  at: string;
  qty: number;
  paid: { contract: string | null; raw: bigint }[];
}

/** Each buy's payment valued when it was paid: `priceOf(contract, at)` gives
 * the paid coin's price then and its decimals (null contract = the chain's
 * native coin), or null when it can't — then the buy's cost is unknown, never
 * partly counted. A buy with nothing paid is unknown too. */
export function valuePaid(events: readonly PaidEvent[], priceOf: (contract: string | null, at: string) => { usd: number; decimals: number } | null): CostEvent[] {
  return events.map((e) => {
    if (e.qty <= 0) return { at: e.at, qty: e.qty, paidUsd: null };
    if (e.paid.length === 0) return { at: e.at, qty: e.qty, paidUsd: null };
    let usd = 0;
    for (const p of e.paid) {
      const px = priceOf(p.contract, e.at);
      if (!px) return { at: e.at, qty: e.qty, paidUsd: null };
      usd += (Number(p.raw) / 10 ** px.decimals) * px.usd;
    }
    return { at: e.at, qty: e.qty, paidUsd: usd };
  });
}

/** One holding's answer (api/token/cost-basis). */
export interface CostBasisRow extends CostBasis {
  chain: string;
  chainName: string;
  holdingQty: number | null;
  /** The first time the token reached the wallet in the history read. */
  firstSeenAt: string | null;
  /** The history was longer than the pages read: the oldest moves are missing. */
  partial: boolean;
}

// Polymarket combos (parlays, owner 2026-10-16): a bet on several markets at
// once, held as its own position that Polymarket's /positions endpoint leaves
// out — they come from /v2/positions/combos, with each leg's live price but
// no value for the combo itself (combos are quoted by market makers, there's
// no order book to mark against). Pure: the adapter fetches, this values.

export interface ComboLeg {
  leg_status: string; // OPEN | RESOLVED_PARTIAL | RESOLVED_WIN | RESOLVED_LOSS
  /** 0–1; 0 when Polymarket has no price. */
  leg_current_price: number | string | null;
  leg_outcome_label: string;
  market: { title: string; icon_url?: string | null; event?: { event_title?: string } | null };
}

export interface ComboPosition {
  combo_condition_id: string;
  current_size: number | string;
  entry_avg_price_usdc: number | string | null;
  entry_cost_usdc: number | string | null;
  status: string; // OPEN | PARTIAL | RESOLVED_PARTIAL | RESOLVED_WIN | RESOLVED_LOSS
  redeemable?: boolean | null;
  legs_total: number;
  legs_resolved: number;
  legs: ComboLeg[];
}

export interface ComboValue {
  /** null: a leg has no price, so the combo's worth is unknown. */
  usd: number | null;
  shares: number;
  cost: number | null;
}

const num = (v: number | string | null | undefined): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};

/**
 * What a combo is worth now: shares × the chance every leg still to play
 * wins — the product of the open legs' prices (a won leg counts 1, a lost one
 * makes the combo 0). An estimate: it treats the legs as independent, as
 * Polymarket's own leg prices do. A won combo waiting to be redeemed is worth
 * its shares. An open leg with no price (Polymarket sends 0) leaves it unknown.
 */
export function comboValue(c: ComboPosition): ComboValue {
  const shares = num(c.current_size) ?? 0;
  const cost = num(c.entry_cost_usdc);
  if (c.status === "RESOLVED_LOSS" || c.legs.some((l) => l.leg_status === "RESOLVED_LOSS")) return { usd: 0, shares, cost };
  if (c.status === "RESOLVED_WIN") return { usd: shares, shares, cost };
  let p = 1;
  for (const l of c.legs) {
    if (l.leg_status === "RESOLVED_WIN") continue;
    const price = num(l.leg_current_price);
    if (price === null || price <= 0) return { usd: null, shares, cost };
    p *= price;
  }
  return { usd: shares * p, shares, cost };
}

/** "10-leg combo: Colts, Falcons, Bills, … (2 of 10 settled)" — the picks,
 * since a combo has no title of its own. */
export function comboLabel(c: ComboPosition, maxPicks = 4): string {
  const picks = c.legs.map((l) => l.leg_outcome_label || l.market.title);
  const shown = picks.slice(0, maxPicks).join(", ") + (picks.length > maxPicks ? ", …" : "");
  const settled = c.legs_resolved > 0 ? ` (${c.legs_resolved} of ${c.legs_total} settled)` : "";
  return `${c.legs_total}-leg combo: ${shown}${settled}`;
}

/** A combo the wallet still holds: shares left, and not already lost. */
export function isHeldCombo(c: ComboPosition): boolean {
  return (num(c.current_size) ?? 0) > 0 && c.status !== "RESOLVED_LOSS";
}

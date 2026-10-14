// A worked-out cost basis is kept (owner 2026-10-14: "shouldn't this value
// just get stored with a refresh button?"), one `app_settings` row per user,
// wallet and coin — `cost_basis:<user>:<wallet>:<price_key>` — so reopening
// the token drawer shows it with no history read; Refresh works it out
// again. Pure: the key and reading the rows back.
import type { CostBasisRow } from "./costBasis.ts";

const PREFIX = "cost_basis:";

export interface SavedCostBasis {
  results: CostBasisRow[];
  note?: string;
  computedAt: string;
}

export function costBasisSettingKey(userId: string, walletId: string, priceKey: string): string {
  return `${PREFIX}${userId}:${walletId}:${priceKey}`;
}

/** A LIKE pattern for every saved row of one user and coin (filtered exactly
 * afterwards: `_` in a key is a wildcard there). */
export function costBasisSettingPattern(userId: string, priceKey: string): string {
  return `${PREFIX}${userId}:%:${priceKey}`;
}

/** The saved answers for one user and coin, by wallet id. */
export function savedForToken(rows: readonly { key: string; value: unknown }[], userId: string, priceKey: string): Record<string, SavedCostBasis> {
  const out: Record<string, SavedCostBasis> = {};
  const head = `${PREFIX}${userId}:`;
  const tail = `:${priceKey}`;
  for (const r of rows) {
    if (!r.key.startsWith(head) || !r.key.endsWith(tail)) continue;
    const walletId = r.key.slice(head.length, r.key.length - tail.length);
    const v = r.value as Partial<SavedCostBasis> | null;
    if (!walletId || walletId.includes(":") || !v || !Array.isArray(v.results) || typeof v.computedAt !== "string") continue;
    out[walletId] = { results: v.results, note: v.note, computedAt: v.computedAt };
  }
  return out;
}

/** The wallet holds a different amount now than when it was worked out (a
 * buy or sale since): the saved figure needs a Refresh. Unknown either side
 * is no claim. */
export function holdingChangedSince(saved: SavedCostBasis, currentQty: number | null): boolean {
  const qtys = saved.results.map((r) => r.holdingQty);
  if (currentQty === null || qtys.length === 0 || qtys.some((q) => q === null)) return false;
  const then = (qtys as number[]).reduce((a, b) => a + b, 0);
  return Math.abs(then - currentQty) > 1e-6 * Math.max(1, Math.abs(currentQty));
}

// A position's liquidity at entry (owner 2026-09-30: only the initial
// liquidity, never updated through the trade). Asked once, when a live
// delivery opens a position — the moment its "opened" alert fires: a coin
// not held at the morning read whose buys today reach ALERT_MIN_USD with
// this delivery. The answer is saved on that delivery's first buy of it
// (`entryLiqUsd`). Solana reuses the Jupiter call the alert makes for the
// coin's supply; EVM asks GeckoTerminal once for every coin opened. Pure.

import type { ActivityBase, ActivityLeg } from "./watchActivity.ts";
import { ALERT_MIN_USD } from "./watchAlerts.ts";

/** Worth less than this at the read is "not held". */
const HELD_USD = 1;

const buyUsd = (legs: readonly ActivityLeg[]) =>
  legs.reduce((s, l) => (l.kind === "swap" && l.qtyDelta > 0 && l.priceUsd !== null ? s + l.qtyDelta * l.priceUsd : s), 0);

/** The coins this delivery opens: each one's first new buy leg. `prev`:
 * the address's legs already saved since the boundary. */
export function openingLegs(prev: readonly ActivityLeg[], added: readonly ActivityLeg[], base: Readonly<Record<string, ActivityBase>>): ActivityLeg[] {
  const out: ActivityLeg[] = [];
  const keys = new Set(added.filter((l) => l.kind === "swap" && l.qtyDelta > 0 && l.contract).map((l) => l.assetKey));
  for (const key of keys) {
    const before = prev.filter((l) => l.assetKey === key);
    if (before.some((l) => l.entryLiqUsd != null)) continue; // already has its entry figure
    const mine = added.filter((l) => l.assetKey === key);
    const price = mine.find((l) => l.priceUsd !== null)?.priceUsd ?? null;
    if (price === null) continue;
    if ((base[key]?.qty ?? 0) * price >= HELD_USD) continue; // held at the read: entered earlier
    const was = buyUsd(before);
    if (was >= ALERT_MIN_USD || was + buyUsd(mine) < ALERT_MIN_USD) continue;
    out.push(mine.filter((l) => l.qtyDelta > 0).sort((a, b) => a.at.localeCompare(b.at))[0]);
  }
  return out;
}

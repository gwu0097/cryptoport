// Hyperliquid /info request weight + a per-minute budget guard — see
// hlWeight.test.ts. Hyperliquid limits /info to 1,200 weight per minute per
// IP: most requests weigh 20 (allMids: 2), and candleSnapshot adds 1 per 60
// candles returned. This app runs on Vercel's shared egress IPs, so other
// tenants spend the same budget: the guard stops at BUDGET_LIMIT (well under
// 1,200), and a real 429 blocks the whole window regardless of what this
// process counted (it can't see anyone else's spend).

export const HL_LIMIT_PER_MIN = 1_200;
export const BUDGET_LIMIT = 900;
export const WINDOW_MS = 60_000;

export type InfoType = "candleSnapshot" | "allMids" | "meta" | "fundingHistory" | string;

/** Weight of one /info request, given how many items it returned (only
 * candleSnapshot's weight depends on it). */
export function requestWeight(type: InfoType, items = 0): number {
  if (type === "allMids") return 2;
  return 20 + (type === "candleSnapshot" ? Math.ceil(items / 60) : 0);
}

/** A sliding one-minute window of spent weight, plus a hard block after a 429. */
export class WeightBudget {
  private spends: { at: number; weight: number }[] = [];
  private blockedUntilMs = 0;
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit = BUDGET_LIMIT, windowMs = WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private inWindow(nowMs: number) {
    return this.spends.filter((s) => s.at > nowMs - this.windowMs && s.at <= nowMs);
  }

  spent(nowMs: number): number {
    return this.inWindow(nowMs).reduce((a, s) => a + s.weight, 0);
  }

  /** When spending is allowed again (0 = now). */
  blockedUntil(nowMs: number): number {
    if (this.blockedUntilMs > nowMs) return this.blockedUntilMs;
    return 0;
  }

  canSpend(weight: number, nowMs: number): boolean {
    return this.blockedUntil(nowMs) === 0 && this.spent(nowMs) + weight <= this.limit;
  }

  /** When enough of the window will have expired for `weight` to fit. */
  nextFitAt(weight: number, nowMs: number): number {
    const blocked = this.blockedUntil(nowMs);
    if (blocked) return blocked;
    let spent = this.spent(nowMs);
    for (const s of this.inWindow(nowMs)) {
      if (spent + weight <= this.limit) break;
      spent -= s.weight;
      if (spent + weight <= this.limit) return s.at + this.windowMs;
    }
    return spent + weight <= this.limit ? nowMs : nowMs + this.windowMs;
  }

  record(weight: number, nowMs: number): void {
    this.spends = this.spends.filter((s) => s.at > nowMs - this.windowMs); // prune
    this.spends.push({ at: nowMs, weight });
  }

  /** Hyperliquid said 429: its view of this IP (all tenants) is exhausted. */
  block(nowMs: number, ms = this.windowMs): void {
    this.blockedUntilMs = Math.max(this.blockedUntilMs, nowMs + ms);
  }
}

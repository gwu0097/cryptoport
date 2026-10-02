// A circuit breaker for the live webhook receivers (2026-10-01: during a
// Supabase outage every delivery still queried the database, adding to the
// jam that kept every page waiting). After FAILS failures within WINDOW_MS
// the receivers skip the database for OPEN_MS and just acknowledge; the
// first delivery after that tries again. Per server instance. Pure (the
// clock is passed in).

const FAILS = 3;
const WINDOW_MS = 60_000;
export const OPEN_MS = 60_000;

export interface Breaker {
  failures: number[];
  openUntil: number;
}

export const newBreaker = (): Breaker => ({ failures: [], openUntil: 0 });

/** Skip the database now? */
export function isOpen(b: Breaker, nowMs: number): boolean {
  return nowMs < b.openUntil;
}

/** A database call failed: opens the breaker on the FAILS-th in WINDOW_MS. */
export function recordFailure(b: Breaker, nowMs: number): void {
  b.failures = [...b.failures.filter((t) => nowMs - t < WINDOW_MS), nowMs];
  if (b.failures.length >= FAILS) {
    b.openUntil = nowMs + OPEN_MS;
    b.failures = [];
  }
}

/** A database call worked: forget earlier failures. */
export function recordSuccess(b: Breaker): void {
  b.failures = [];
}

// How often an open Wallet Watch activity panel fetches its lines after a
// live update's broadcast (owner, 2026-09-28): fast only while the viewer
// has "Watching" on — for an hour, then it turns itself off — and at most
// every 30 minutes otherwise. Each fetch is ~4 Supabase requests; nothing
// fetches unless a live wallet traded. Pure.

/** Watching turns itself off after this long; the viewer turns it on again. */
export const WATCH_FOR_MS = 60 * 60_000;
/** While watching: wait this long after a broadcast, so trades landing
 * together come in one fetch… */
export const WATCHING_SETTLE_MS = 1_000;
/** …and fetch at most this often. */
export const WATCHING_GAP_MS = 15_000;
/** Not watching: at most this often. */
export const IDLE_GAP_MS = 30 * 60_000;

export function isWatching(untilMs: number | null, nowMs: number): boolean {
  return untilMs !== null && untilMs > nowMs;
}

/** How long to wait, after a broadcast, before fetching. */
export function fetchDelay(lastFetchMs: number, nowMs: number, watching: boolean): number {
  const gap = watching ? WATCHING_GAP_MS : IDLE_GAP_MS;
  return Math.max(watching ? WATCHING_SETTLE_MS : 0, lastFetchMs + gap - nowMs);
}

/** Whole minutes left, never below 1 while still on. */
export function minutesLeft(untilMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((untilMs - nowMs) / 60_000));
}

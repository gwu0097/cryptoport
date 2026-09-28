// The Realtime channel live Wallet Watch updates are announced on (phase 5):
// shared by the server that broadcasts (liveBroadcast.ts) and the pages that
// listen (DayActivity). Pure constants, safe on both sides.
export const ACTIVITY_CHANNEL = "wallet-watch-activity";
export const ACTIVITY_EVENT = "activity";
/** A listening page fetches its lines at most this often. */
export const LIVE_REFETCH_MS = 60_000;

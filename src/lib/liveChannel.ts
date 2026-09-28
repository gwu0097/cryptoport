// The Realtime channel live Wallet Watch updates are announced on (phase 5):
// shared by the server that broadcasts (liveBroadcast.ts) and the pages that
// listen (DayActivity; how often: liveWatching.ts). Pure constants, safe on
// both sides.
export const ACTIVITY_CHANNEL = "wallet-watch-activity";
export const ACTIVITY_EVENT = "activity";

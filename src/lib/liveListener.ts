import { browserSupabase } from "./supabaseBrowser";
import { ACTIVITY_CHANNEL, ACTIVITY_EVENT } from "./liveChannel";

// One Realtime subscription per browser tab for Wallet Watch live updates,
// opened on first use and kept for the tab's life; panels register listeners
// on it. Each panel subscribing and removing its own channel lost messages:
// moving between pages (or React's dev double-mount) removed the old channel
// while joining the same topic again, and the new one never joined
// (reproduced 2026-09-28: a broadcast reached no panel on an influencer page).

type Listener = () => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<Listener>();
let started = false;

function start() {
  if (started) return;
  started = true;
  let dropped = false;
  browserSupabase()
    .channel(ACTIVITY_CHANNEL)
    .on("broadcast", { event: ACTIVITY_EVENT }, () => listeners.forEach((l) => l()))
    .subscribe((status: string) => {
      if (status === "SUBSCRIBED" && dropped) reconnectListeners.forEach((l) => l());
      if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") dropped = true;
    });
}

/** Called on every "new activity" broadcast, and once after a dropped
 * connection comes back (something may have been missed). Returns the
 * unsubscribe for this listener only; the shared channel stays open. */
export function onLiveActivity(listener: Listener): () => void {
  start();
  listeners.add(listener);
  reconnectListeners.add(listener);
  return () => {
    listeners.delete(listener);
    reconnectListeners.delete(listener);
  };
}

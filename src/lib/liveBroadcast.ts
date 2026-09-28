import "server-only";

// Tells open pages that live Wallet Watch activity changed (phase 5): one
// Supabase Realtime broadcast after a webhook delivery saves something. The
// message carries no data (not even which wallet) — a listening page fetches
// its own lines through /api/wallet-watch/day, with the user's permissions.
// Best-effort: a failed broadcast only means the page updates on its next load.

import { ACTIVITY_CHANNEL, ACTIVITY_EVENT } from "./liveChannel";

export async function broadcastActivity(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: ACTIVITY_CHANNEL, event: ACTIVITY_EVENT, payload: {}, private: false }] }),
      cache: "no-store",
    });
  } catch {
    // best-effort (see above)
  }
}

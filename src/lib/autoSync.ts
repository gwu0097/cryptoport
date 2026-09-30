// "Auto-sync daily" wallets (owner 2026-09-30): a wallet whose coins change
// often (one you trade from) is synced when its owner presses Refresh
// prices, at most once a day — no cron, so nothing runs for wallets nobody
// is looking at. Pure: which wallets are due.

/** At most this many per user: each is a full sync (5–10 s, 10–20 database
 * requests, and a Zerion call for an EVM wallet). */
export const AUTO_SYNC_MAX = 5;
/** How often each is synced at most. */
export const AUTO_SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

export interface AutoSyncCandidate {
  id: string;
  mode: string;
  provider: string | null;
  address: string | null;
  auto_sync?: boolean;
  last_refresh_at: string | null;
  exchange_synced_at?: string | null;
}

/** When the wallet's holdings were last synced (an exchange has its own). */
const syncedAt = (w: AutoSyncCandidate) => (w.provider ? (w.exchange_synced_at ?? null) : w.last_refresh_at);

/** Can this wallet be synced at all: an address wallet in auto mode, or a
 * connected exchange. */
export function canAutoSync(w: Pick<AutoSyncCandidate, "mode" | "provider" | "address">): boolean {
  return w.provider !== null || (w.mode === "auto" && !!w.address);
}

/** The marked wallets not synced in the last day, oldest first, at most
 * AUTO_SYNC_MAX. A sync that's running now is the queue's to skip. */
export function dueForAutoSync<W extends AutoSyncCandidate>(wallets: readonly W[], nowMs: number): W[] {
  return wallets
    .filter((w) => w.auto_sync && canAutoSync(w))
    .filter((w) => {
      const at = syncedAt(w);
      return at === null || nowMs - Date.parse(at) >= AUTO_SYNC_EVERY_MS;
    })
    .sort((a, b) => (syncedAt(a) ?? "").localeCompare(syncedAt(b) ?? ""))
    .slice(0, AUTO_SYNC_MAX);
}

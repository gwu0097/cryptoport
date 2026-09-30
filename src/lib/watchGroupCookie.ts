// The Wallet Watch group last picked (owner 2026-09-30: coming back shouldn't
// reset to All): GroupTabs writes it, the page reads it when its link names
// no group. "all" = All. Pure.

export const WATCH_GROUP_COOKIE = "cryptoport_watch_group";

/** The cookie string that remembers `group` for a year. */
export const watchGroupCookie = (group: string) => `${WATCH_GROUP_COOKIE}=${encodeURIComponent(group)}; path=/; max-age=31536000; samesite=lax`;

// Plain values/types shared between a client table component and its
// Server Component page — deliberately NOT re-exported from AssetsTable.tsx/
// WatchlistTable.tsx (both "use client"). A Server Component that imports a
// runtime value (not JSX-rendered) from a "use client" module gets an
// opaque client-reference stub instead of the real value — Next's RSC
// bundler replaces every export of a client-boundary module with one of
// these, since it can't tell ahead of time which exports will be rendered
// as components vs. used as plain data. `SORT_KEYS.includes(...)` on that
// stub isn't a real array method call, and throws — a real bug hit live
// (assets/page.tsx and watchlist/page.tsx crashed with a server error on
// every request once they imported SORT_KEYS straight from the client
// table files). Types are unaffected by this (import type is erased
// entirely, no runtime reference crosses the boundary either way), but
// runtime constants like this one need their own home in a plain module
// both sides can safely import.

export type SortDirection = "asc" | "desc";

export type AssetSortKey =
  | "ticker"
  | "price"
  | "change1h"
  | "change24h"
  | "change7d"
  | "change30d"
  | "marketCap"
  | "qty"
  | "wallets"
  | "value";
export const ASSET_SORT_KEYS: readonly AssetSortKey[] = [
  "ticker",
  "price",
  "change1h",
  "change24h",
  "change7d",
  "change30d",
  "marketCap",
  "qty",
  "wallets",
  "value",
];

export type DefiSortKey = "protocol" | "wallets" | "value";
export const DEFI_SORT_KEYS: readonly DefiSortKey[] = ["protocol", "wallets", "value"];

export type WatchlistSortKey = "ticker" | "price" | "change1h" | "change24h" | "change7d" | "change30d" | "marketCap";
export const WATCHLIST_SORT_KEYS: readonly WatchlistSortKey[] = [
  "ticker",
  "price",
  "change1h",
  "change24h",
  "change7d",
  "change30d",
  "marketCap",
];

export type PeerSortKey = "ticker" | "price" | "change1h" | "change24h" | "change7d" | "marketCap" | "correlation";
export const PEER_SORT_KEYS: readonly PeerSortKey[] = [
  "ticker",
  "price",
  "change1h",
  "change24h",
  "change7d",
  "marketCap",
  "correlation",
];

/** AND-semantics tag filter, shared by WalletsTable (which rows to show)
 * and SyncAllWalletsButton (which wallets "Sync all" actually syncs) —
 * both need the exact same "does this wallet carry every selected tag"
 * predicate, extracted up front rather than letting a second copy exist
 * even briefly (see CLAUDE.md's "grep before copying" rule — duplicating
 * this once was already the trigger, not the second time). A wallet needs
 * every selected tag, not just one of them (user-confirmed: "personal" +
 * "soft wallet" should narrow to wallets carrying both, not widen to
 * either). Generic over any wallet-shaped object carrying `tags` so it
 * works for both WalletWithTotal (WalletsTable) and the narrower shape
 * SyncAllWalletsButton needs. */
export function filterWalletsByTags<W extends { tags: { name: string }[] }>(wallets: W[], tagFilter: string[]): W[] {
  if (tagFilter.length === 0) return wallets;
  return wallets.filter((w) => tagFilter.every((name) => w.tags.some((t) => t.name === name)));
}

/** The fields a wallet search looks at. Optional so narrower wallet shapes
 * still type-check; a missing field just can't match. */
export interface WalletSearchFields {
  name?: string;
  chain?: string;
  address?: string | null;
  notes?: string | null;
  tags: { name: string }[];
}

/** Case-insensitive search over name, chain, address, notes and tag names.
 * Whitespace-separated terms are ANDed (same narrowing semantics as the tag
 * filter): "ledger sol" matches "Ledger Solana - Biz" but not "Ledger ETH".
 * An empty or whitespace-only query matches everything. */
export function matchesWalletSearch(w: WalletSearchFields, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [w.name, w.chain, w.address, w.notes, ...w.tags.map((t) => t.name)]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/** The Wallets list's full filter: selected tags (AND) plus the search box.
 * Shared by WalletsTable (rows), SyncAllWalletsButton (what "Sync all"
 * syncs) and WalletsTotalValue (the header total) so all three always agree
 * on "the wallets currently shown". */
export function filterWallets<W extends WalletSearchFields>(wallets: W[], filter: { tags: string[]; query: string }): W[] {
  return filterWalletsByTags(wallets, filter.tags).filter((w) => matchesWalletSearch(w, filter.query));
}

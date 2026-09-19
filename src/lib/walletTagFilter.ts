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

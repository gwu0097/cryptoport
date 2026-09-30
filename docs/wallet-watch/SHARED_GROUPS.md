# Shared groups — plan (2026-09-30)

Owner request: share a Wallet Watch group with another user (DJ); either of
them adding or removing an influencer in it is seen by the other. Agreed
defaults (owner, 2026-09-30):

- **One shared group, not copies.** Members see the same group and the
  influencers in it — like a shared playlist — not the per-influencer copy
  link (`watchCopySync.ts`), which stays as it is.
- **Joining:** the group's creator presses Share group and sends the link
  (`/wallet-watch/join/<token>`); a signed-in user who opens it becomes a
  member. The creator can remove members or stop sharing (a new token next
  time); a member can leave.
- **Any member** adds their own influencers to the group, removes any
  influencer from the group, and sees everything of the group's
  influencers that the creator of each sees: holdings, activity, movements,
  positions, daily value, trading record.
- **Only an influencer's creator** renames it, changes its addresses,
  shares it, deletes it, or turns live on (live stays owner-only app-wide).
- **Only the group's creator** renames or deletes the group, removes
  members, stops sharing.
- **Caps:** the 25-influencer cap counts only influencers a user created;
  a group has at most 20 members.
- **Unchanged:** a member's own other groups and influencers stay private;
  unsaved searches can't be put in a shared group (they aren't in groups).

## How other products do it

Shared collections (Notion workspaces, Spotify collaborative playlists,
Nansen/Arkham shared watchlists): the unit of truth is one collection row;
membership is a join table; visibility is "you own it or you're a member".
Items keep their creator (who alone can edit or delete the item), any
member can add or remove items. Invite by link is the common light-weight
path; per-user invites by email are the heavier one — not needed here.

## Data

- `watch_groups.share_token uuid unique` — null = not shared.
- `watch_group_members (group_id, user_id, joined_at, primary key (group_id, user_id))`
  — the creator isn't a row (they're `watch_groups.user_id`).
- `watch_group_influencers.user_id` already exists: it becomes "who added
  this influencer to the group" (today always the owner of both).

## Visibility (RLS)

One security-definer function, so policies don't recurse:

- `cryptoport.watch_visible_influencers()` → the influencer ids the caller
  may read: their own, plus every influencer linked to a group they created
  or are a member of — only for groups that are shared (`share_token` set)
  or have members. Stable, `set search_path = cryptoport`, reads with the
  function owner's rights, returns `setof uuid`.
- `cryptoport.watch_my_groups()` → group ids the caller created or joined.

Policies (existing "owner only" policies stay for writes):

| Table | Read | Write |
|---|---|---|
| watch_groups | own, or `id in watch_my_groups()` | own only (rename, delete, token) |
| watch_group_members | own group's rows, or `user_id = auth.uid()` | insert only via `join_watch_group(token)` (security definer); delete: the group's creator, or yourself (leave) |
| watch_group_influencers | `group_id in watch_my_groups()` | insert: group in `watch_my_groups()` and influencer is yours; delete: group in `watch_my_groups()` |
| watch_influencers | own, or `id in watch_visible_influencers()` | own only |
| watch_influencer_addresses | own, or `influencer_id in watch_visible_influencers()` | own only |
| watched_addresses, watched_address_daily, watched_movements, watched_positions | address belongs to an influencer in `watch_visible_influencers()` (was: to one of yours) | service role |

`my_market_rows` is `security invoker`, so the price scope follows
`watched_addresses`' policy with no change.

`watch_enforce_caps` counts `user_id = new.user_id` rows, which is already
"influencers you created" — unchanged. Member cap: a trigger on
`watch_group_members` (20).

## App

- `watchQuery.ts` reads unchanged (RLS widens them); rows gain `mine`
  (`user_id = auth user`) and groups gain `shared` / `mine` / member count.
- `setInfluencerGroups` becomes add / remove one link (it deletes every
  link of the influencer today — with shared groups that would remove other
  members' links). `GroupChips` already toggles one group at a time.
- UI: a group tab shows a shared icon; "Share group" / "Members" / "Stop
  sharing" / "Leave group" next to the group's Delete; on another member's
  influencer, rename / delete / live / addresses controls are hidden and a
  small "added by …" note shows (member display = email local part — the
  only name a user has).
- Join page `/wallet-watch/join/[token]`: signed in → join (security
  definer RPC) → redirect to the group; not signed in → sign-in prompt.
- Dashboard feed and Insights include the shared group's influencers (they
  read through RLS) — intended: they're in the viewer's group.

## Cost

- External APIs: none. An address is read once a day however many watch it.
- Supabase: +1 small request per Wallet Watch page (members of the viewer's
  shared groups); the visibility functions run inside existing queries.
  At today's scale (< 10 users, < 100 influencers) the function is a few
  index lookups; at 10× still one query per policy check on indexed columns
  (`watch_group_members` pk, `watch_group_influencers_influencer_idx`).
- Vercel: none beyond the join page.

## What fails and how it shows

- A member removed or sharing stopped: their next page load no longer sees
  the group (RLS) — nothing to clean up in their account.
- The group's creator deletes it: cascade removes members and links; other
  members' influencers stay in their accounts.
- A member deletes their influencer: it leaves the group (cascade).
- Old share link after Stop sharing: the token no longer matches → "This
  link is no longer valid".

## Phases (one commit each, on `hold/shared-groups` until the SQL runs)

1. SQL (table, columns, functions, policies) + `db/schema.sql`; verified
   with two users by reading as each through the REST API before any UI.
2. App: queries (`mine`, `shared`), add/remove link, join page, share /
   members / leave / stop sharing, hidden controls on others' influencers.

## Verification

- As the owner and a second test account: share, join, each adds an
  influencer, both see both; a member removes one; creator removes the
  member → the member sees none of it; non-members see nothing (REST read
  with the anon key + each user's token).
- Supabase logs: requests per Wallet Watch view before/after (+1 expected).

## Review (Fable, 2026-09-30) — changes adopted

- **Visibility = membership only.** Stop sharing clears the token *and*
  deletes the member rows; a stale member can't come back on re-share.
- **Every owner-only action checks ownership in the query**
  (`.eq("user_id", user.id)` + `.select()`): RLS makes an update of a
  visible-but-not-owned row match 0 rows without an error, so an empty
  result returns "Only its creator can …" (rename, note/link, delete,
  addresses, share / unshare, directory, groups rename/delete).
- **Shared by design, stated:** members see a shared influencer's note and
  its share link, and a shared group's invite link (any member can invite).
  Column grants to hide them were weighed and not worth a second read path
  for a group of people who trust each other.
- **Link insert check:** `user_id = (select auth.uid())`, the group is one
  of yours, the influencer is yours and saved (`unsaved_since is null`).
- **Security-definer hygiene:** `stable`, `set search_path = cryptoport,
  pg_temp`, execute revoked from public/anon and granted to authenticated;
  `(select auth.uid())` in policies; `watch_groups` and
  `watch_group_members` refer to each other only through the functions.
- **join_watch_group(token):** signed in; the creator gets the id back
  with no row; already a member → nothing; 20-member cap under an advisory
  lock; unknown token → null.
- **Indexes:** `watch_group_members(user_id)`, `watch_groups(user_id)`.
- **"Mine" reads fixed in the app:** the save-count in `renameInfluencer`,
  `searchWallet`'s already-watched check and unsaved trim, `getDirectory`'s
  `mine`, the lookup page's "watching as" — all by `user_id`;
  `readWatchBase` selects `user_id` for `mine`.
- **Forms and chips:** another member's influencer offers only remove-from-
  shared-group chips; the add-address form lists own influencers only;
  rename / delete / addresses / share / live controls only on your own.
- **Members may trigger reads of shared rows** (Refresh, Refresh activity,
  trading record, backfill) — the rows are shared and every one of those
  reuses a fresh result (a read < 15 min, a record < 1 h), so a second
  viewer costs nothing extra. Live stays admin-only, now on any visible
  influencer (the owner is the only admin).
- **Member names:** one security-definer function returns each co-member's
  email local part (before the @) for groups you're in — visible only to
  members of the same group.

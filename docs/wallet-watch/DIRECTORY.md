# KOL directory — plan (owner 2026-09-28)

## Goal

One maintained list of known traders (KOLs) with their wallets, so users
don't each keep their own drifting copy (DJ's VirtualBacon missed the
second wallet the owner found). Users add a KOL from the list in one click
and it follows the list; anyone can still keep their own influencers
outside it.

## How others do it (checked from their public docs, not live)

- **Nansen:** mostly automatic — "Smart Money" is chosen by performance, not
  identity; name labels from rules plus an internal team.
- **Arkham:** automatic clustering by on-chain behaviour, analysts, and the
  Intel Exchange (bounties for proving who owns a wallet, checked by Arkham).
- **DeBank:** people prove their own wallets by signing.
- **KOLScan / GMGN / Cielo:** small curated KOL lists (wallets the KOLs
  posted) plus automatic "top trader" lists by profit.

The unit of truth everywhere is one entity per person, kept in one place,
that users follow — never a copy each user maintains. Nobody hand-types
everything: performance lists are computed, linked wallets are found on
chain, and a person checks what gets published.

## Decisions (owner)

- **Only the owner edits the directory.** An entry is one of the owner's
  own influencers marked "in the directory" (`watch_directory`, service
  role only — no user can write it). Users' copies never write back.
- **Adding from the directory makes a following copy** — the share-link
  mechanism (`addSharedInfluencer`, `copied_from`, `watchCopySync.ts`): the
  owner's address changes reach every copy; the user's groups and note are
  theirs; "Stop following" makes it their own. A directory entry is always
  shared (its token is created when it's added).
- **Users may suggest a wallet for a directory KOL; the owner approves** it
  in the Owner's console. A suggestion reaches nobody until approved.
- **A wallet is only published with evidence**, shown at review: transfers
  between it and the KOL's known wallets (both directions, repeated — one
  incoming transfer proves nothing, anyone can send tokens), outside labels
  or the KOL's own post (a link), trading overlap.

## Phases

1. **Directory** — `watch_directory (influencer_id, added_at)`; the owner's
   "Add to KOL directory" switch on an influencer page (admin only); a
   "KOL directory" page (Tools) listing entries — wallets, value, top
   holdings — with "Add to my Wallet Watch" (a following copy) or "In your
   Wallet Watch". Gate: add VirtualBacon and Murad, add one from a second
   account, add a wallet to the original and see it arrive.
2. **Suggestions** — `watch_suggestions` (who, which KOL, chain, address,
   why/link, status, decided_at; RLS: users insert and read their own); a
   "Suggest a wallet" form on a directory KOL's page; an Owner's console
   tab "Suggestions" with approve / reject and an on-demand evidence check
   (Alchemy transfers between the suggested wallet and each known wallet on
   the chains they share: ~2 calls per pair per chain). Approve = add the
   address to the owner's influencer (reaches every copy).
3. **Linked-wallet suggestions** — the morning read's transfers already name
   counterparties; a wallet exchanging value with a directory KOL's wallet
   repeatedly, both ways, is queued as a system suggestion with the
   transfers as evidence (no extra API calls).

Performance-based discovery (Solana Tracker's leaderboard) stays separate:
it finds wallets that trade well, it doesn't claim who they are.

## Blast radius

Two small tables, service-role writes only for the directory; no new
external service in phases 1 and 3; phase 2's evidence check is a few
Alchemy calls per review. Supabase: the directory page is ~4 requests
(entries, addresses, their snapshots, the viewer's copies); prices come
from the request's shared map.

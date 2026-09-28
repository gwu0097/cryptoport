# Wallet Watch — design

Status: **phases 1–3 built 2026-09-26** (scope approved by the owner,
Fable review folded in); phase 4 (alerts, trade-level history) later. Needs new tables and a daily cron, so CLAUDE.md
§8 applies: SQL in chat, owner runs it, then code.

Vocabulary (the owner's): an **influencer** is one person with up to 5
addresses; a **group** is the user's own set of influencers followed for one
reason ("Gem pickers", "Macro"). An influencer can be in several groups.

## Goal

Follow other people's wallets — influencers, funds, "smart money" — the way
the Watchlist follows coins: save an address from the search bar under a name,
group them by purpose, see what they hold and **what they changed**, and later
judge whether they're worth following (track record, what they're buying as a
group, how their moves overlap with mine).

It lives under a new **Tools** section in the nav. It never touches the
user's own portfolio: watched wallets are not holdings, never in any total,
never in Analytics' figures.

## How leading products do it

| Product | Unit of truth | What we take from it |
|---|---|---|
| **Arkham** | An *entity* (a person/fund) owning many addresses, with labels; alerts on movements | A watched wallet is a *person* with several addresses (their EVM + Solana + BTC), not one address |
| **Nansen** (Wallet Profiler, Smart Money) | Address → balances, PnL per token, top trades, counterparties; "Smart Money" = labeled wallets with good track records | Per-wallet track record (realized/unrealized PnL, win rate) and *group* flows ("what smart money bought this week") |
| **DeBank** (Follow, Stream) | Followed addresses → a feed of their transactions | A movements feed across everyone you follow |
| **Cielo / GMGN** | Wallet tracking with instant alerts; per-token PnL, win rate, hold time (Solana-heavy) | Win rate / hold time as the core credibility numbers; alerts later |
| **Zerion** | Watchlist of addresses with the same portfolio view as your own | Reuse our own wallet view for a watched address |

Common shape: **entity → addresses → holdings snapshots + movement events →
per-entity and per-group analytics.** Everyone derives "movements" from
transactions; the cheap first step (Zerion, DeBank's portfolio history) is
comparing balances over time.

## Which existing service provides it

- Holdings: **our own adapters** — the ones a wallet sync uses (every chain
  we support, EVM discovery, Hyperliquid/Lighter/Aster perps, Polymarket).
  No new provider. **Not** through `lookupWallet` (the search bar): it drops
  the adapters' failure scopes and passes no previous tokens, so a chain that
  fails just returns fewer rows (review #1, below).
- Paid options checked against the "indexer before our own scanning" rule:
  Arkham, Nansen and DeBank Pro APIs are paid-only for this data; Zerion's
  free tier (300 calls/day app-wide) is already the DeFi budget for users'
  own syncs. So v1 reads balances with what we have, and **skips Zerion DeFi
  for watched wallets** (see decisions) — native adapters (incl. Hyperliquid,
  where influencers' positions are public and the most interesting) still run.

## Data model (all in `cryptoport`, §4.6)

Shared per address, so ten users watching the same influencer cost one read:

- `watched_addresses` (shared): `chain, address` (PK; EVM addresses
  lowercased, `chain` is the address family from `detectChain` — "ETH"
  covers every EVM chain plus the EVM venues), the latest `snapshot` (jsonb,
  below), `total_usd`, `unpriced_count`, `last_refresh_at`,
  `last_refresh_status`, and a job claim: `refresh_status`,
  `refresh_started_at`, `next_refresh_at`.
- `watched_address_daily` (shared, phase 2): `chain, address, day,
  total_usd, cash_usd, unpriced_count`.
- `watched_movements` (shared, phase 2): `chain, address, snapshot_at,
  asset_key, kind, ticker, price_key, qty_before, qty_after, price_usd`
  (nullable — unknown is never 0), `usd_delta` (nullable),
  `wallet_total_usd_after`; unique `(chain, address, snapshot_at,
  asset_key, kind)`, so a repeated cron delivery is a no-op.
- `watched_positions` (shared, phase 2): per `(chain, address, asset_key)`
  `first_seen_at`, `last_seen_at`, entry price and qty at first sight — what
  phase 3's track record and hold times read.

**Snapshot contents.** Every row the adapters saw, including tokens that are
unrecognized or dust *today* (flagged, not valued), in a compact form:
`asset_key, chain, contract, ticker, price_key, qty, usd | null, kind`
(`token`, `unrecognized`, `dust`, `perp`, `prediction`, `venue_cash`).

**Asset identity for diffing** (`asset_key`):
- a priced coin: its `price_key`, with quantities **summed across chains**
  (USDC on Base and on Arbitrum is one asset; a bridge is not a movement).
  The per-chain breakdown stays in the snapshot for display. A receipt
  valued as its underlying ("hUSDB (as USDB)") keeps its own contract as its
  key, so it never merges with the underlying it's priced as;
- a token with no price: `chain:contract`;
- a perp: `perp:<venue>:<market>:<side>`; a prediction share: its venue
  row identity (`carryForward.ts` `identity`).

Per user (RLS owner only, `user_id default auth.uid()`; every table
carries `user_id`):

- `watch_influencers`: `name`, `note`, `link` (X/Farcaster profile),
  `created_at`.
- `watch_influencer_addresses`: `influencer_id, chain, address`.
- `watch_groups` + `watch_group_influencers` (many-to-many, like
  `watchlists`).

**Who can read the shared tables:** only users who watch that address (the
`watchlist_items` subquery pattern: `exists (select 1 from
watch_influencer_addresses w where w.user_id = auth.uid() and w.chain = …
and w.address = …)`), never every signed-in user — otherwise anyone could
list the addresses everyone else watches. Writes are service role only.

**Caps** (25 influencers per user, 5 addresses each) are enforced in the
database by a trigger that takes a per-user advisory lock and counts, not by
the UI or a Server Action's count-then-insert.

**Storage** (500 MB plan; the storage watch line is 350 MB and the steady
state ~205 MB, so the real headroom is ~145 MB). No per-day holdings copies —
the latest snapshot, one daily number per address, change events and one
row per position. A compact snapshot row is ~120 bytes; an active EVM
wallet has 100–400 rows including unrecognized ones, so ~15–50 KB per
address. At 200 distinct addresses: snapshots ≈ 10 MB, a year of daily rows
≈ 5 MB, movements and positions ≈ 10–20 MB. Retention: 400 days for daily
rows and movements, matching the screener's archive rule. An app-wide cap
of 500 distinct watched addresses keeps the worst case under ~40 MB; the
table sizes are checked after phase 1 and phase 2.

## Refresh and movements

**One refresh function** reads an address, and every write of a snapshot —
the daily cron's and an on-demand Refresh's alike — goes through it, so a
change between two snapshots is always recorded (review #5):

1. Read the address with the sync's adapters (`fetchAdapterHoldings`
   style), passing the stored snapshot's tokens per chain as `previous`, so
   discovery always re-reads last run's tokens (a token the indexer misses
   one day isn't lost).
2. Apply `carryForward` against the stored snapshot: a chain or source that
   failed keeps its rows, and the status names it (`keptNote`). If every
   source failed, the snapshot and status stay as they were.
3. (Phase 2) Diff against the stored snapshot and write movements, then save
   the snapshot and the day's row.

**Movement rules** (phase 2):
- Only a change in **quantity** is a movement, never a price or a
  classification change (a token going unpriced or under the dust floor
  isn't an exit). A kept row (from carryForward) never produces one.
- Kinds: `new`, `added`, `trimmed`, `exited` (quantity to zero, all chains
  read successfully), `perp_opened`, `perp_closed`, `perp_resized` (size,
  not margin — margin moves with PnL). A change counts when it's at least
  $100 and either at least 1% of the previous quantity or at least $5,000
  (named constants; 5% until 2026-09-28, which hid real adds to big
  positions).
- **Venue cash** (Hyperliquid/Lighter/Aster account cash, vault equity)
  moves with PnL and funding every day, so it's never a token movement.
- Liquid staking and wrapping (ETH → stETH, via `liquid_staking_tokens`)
  and moves between chains are labeled "converted"/"moved", not an exit
  plus a new position (nice-to-have; phase 2 if simple).

**Daily cron.** Vercel Hobby crons run once a day, anywhere within the hour,
and can be delivered twice; there's no server-side fan-out today (Sync all
runs in the browser), and every rate-limit pacer is per server instance. So:
- its own route (`/api/cron/wallet-watch`), a later hour than
  `/api/cron/snapshot`;
- it first prices every watched coin once in one batched pass (as
  `primeSyncPricesAction` does), then claims addresses by compare-and-set
  (`refresh_status`, stale after `JOB_STALE_MS`), oldest `next_refresh_at`
  first, and drains them in lanes (`syncLanes.ts`) until ~250 s;
- capacity: ~5 s per EVM address at two at a time is ~90–100 addresses per
  run. Anything left waits for the next run and shows its real "last
  refreshed". If that becomes common, add Supabase pg_cron + pg_net calls to
  the same route every 30 minutes (the signal-alerts precedent) — no design
  change, since claiming already handles it.
- Watched coins are **not** added to the Refresh prices button (it would
  grow every user's refresh with other people's coins); their prices are
  as fresh as the last cron or Refresh, captioned (§4.5).
- **Honest limits, shown in the UI:** daily snapshots see the net change per
  day (a buy and sell the same day is invisible); the price on a movement is
  that day's price, not the trade's. Transaction-level detail (exact trades,
  counterparties) is a later phase via `transactionSources.ts`.

### Budget

Per watched address per refresh: the same calls as a wallet sync minus
Zerion (Alchemy discovery per EVM chain, RPC multicall, native protocol
adapters; Helius for Solana). CoinGecko: one batched pricing pass per cron
run over every watched coin (`/coins/markets`, 250 ids per call), plus
`ensureAssetPrices` for coins first seen in that run. Each new coin also
adds a daily close to `asset_price_daily`. Logged per run like `sync_runs`.

### At 10× users / addresses

Shared per-address storage means cost grows with *distinct* addresses, not
watchers. Cron time is the limit (~100 addresses per run, above); past that,
pg_cron runs it more often. An address that fails keeps its last snapshot
and emits no movements (§4.3 — a failed read is never "sold everything").

## UI

**Tools → Wallet Watch** (`/wallet-watch`)
- Groups as tabs (All, plus the user's groups), like the Watchlist.
- Table per wallet: name (+ link icon), chains, value, 24h/7d value change,
  cash %, top 3 holdings, last movement, last refreshed. Sortable, mobile
  columns per §7.
- **Activity feed** for the selected group: movements newest first — "Ansem
  added 1.2M WIF (+$410k) · 2d ago", "Cobie exited ETH". Filter by kind.
- **"Watch this wallet" on the lookup page:** name it, add more addresses of
  the same person, pick groups. Also from Wallet Watch directly (paste
  address).

**Wallet page** (`/wallet-watch/[id]`): the holdings view the lookup already
renders (all addresses combined, by chain), value chart, movement history,
and the analytics below.

## Analytics for influencer wallets — **Watch Insights** (phase 3)

Its own page under Tools (`/watch-insights`), per group. The headline is
**convergence**: coins that several influencers in the same group bought
recently — the owner's "gems multiple influencers are buying" — ranked by
how many of them, how much they put in (as a share of each one's wallet, so
a whale's dust doesn't outrank a small wallet's conviction), and how early.
Across groups, the same coin appearing in more than one group is shown too.

What matters when following someone is **whether their moves are worth
anything and whether they act on what they say**:

1. **Track record** (per wallet): for every position opened since we started
   watching — entry (price on the day it appeared), exit or current price,
   PnL; **win rate**, median **hold time**, best/worst call. Realized vs
   unrealized kept apart. Shown with "since <first snapshot>" — nothing before
   we started watching is claimed.
2. **Early or late:** where they bought relative to the coin's move — the
   coin's 30-day return *before* their entry vs *after*. Separates people
   who find things early from people who buy tops (and who may be exit
   liquidity for others).
3. **Conviction and style:** position sizes as % of their wallet,
   concentration, turnover (how much of the wallet changes per month), and
   **cash ratio over time** — a wallet moving to stablecoins is a risk-off
   tell worth more than any tweet.
4. **Say vs do** (manual at first): a note field and link per wallet; later,
   flag when a wallet *sells* a coin it holds big while it's up sharply (the
   classic "shill and dump" pattern: exit during a +X% week).
5. **Group signals** (per group; convergence above is the first of these): **net flows** — which coins the group bought
   or sold most this week in dollars and by how many wallets ("4 of 9 added
   HYPE"); **consensus holdings** (held by most of the group); **new
   entries** first bought by anyone in the group this week.
6. **Overlap with me:** which of my coins my watched wallets hold, and who's
   been adding or trimming them — "3 wallets you watch trimmed SOL this week".
7. **Perps (Hyperliquid, public):** open positions, leverage, liquidation
   price, PnL — often the most telling real-time exposure an influencer has.

Every figure follows the app's rules: unknown is "—", nothing is a buy/sell
signal (like the screener and signals), thresholds are fixed and named.

Data limits: track record counts only positions opened since we started
watching, and skips entries with no price. **Early/late** needs a coin's
price for the 30 days before entry, which we only have for coins with stored
history; others show "—" (a CoinGecko backfill for them would be a budgeted
decision, §5). **Cash ratio** counts coins in CoinGecko's "Stablecoins"
category (`coin_categories`) plus `fiat:USD`.

## Phases (one commit each, owner sign-off between)

1. **Tools + Wallet Watch core** — tables (influencers, addresses, groups,
   watched_addresses), the page with groups, "Watch this wallet" on lookup,
   the wallet page from the stored snapshot, on-demand Refresh. *Gate:*
   add 3 real influencer wallets via the UI; their values match the lookup
   page and an external viewer (DeBank/Solscan).
2. **Movements** — daily cron + diffing + `watched_movements` +
   `watched_positions` + activity feed + value chart. *Gate:* unit tests for
   the diff (a forced chain failure keeps rows and yields zero movements; a
   token going unpriced isn't an exit; venue cash never moves; USDC across
   chains is one asset); two cron runs; each movement checked against the
   chain explorer for 3 wallets.
3. **Watch Insights** — convergence, track record, early/late, cash ratio, group flows,
   overlap with my portfolio. *Gate:* each metric hand-checked for one
   wallet from its movements.
4. **Activity check** (transactions since the morning read, on demand) —
   below. *Gate:* below.
5. **Later:** alerts (Discord, reusing `hold/signal-alerts`), shared/public
   groups.

## Decisions (owner, 2026-09-26)

1. **Daily automatic refresh** of watched addresses: yes.
2. **No Zerion DeFi** for watched addresses — what matters is big positions
   they buy and move. Native adapters (incl. Hyperliquid perps) still run.
3. **Caps:** 25 influencers per user, 5 addresses each.
4. **Tools** holds Wallet Watch and (phase 3) Watch Insights only.
5. **Groups of influencers** by purpose; convergence within a group (and
   across groups) is the core of Watch Insights.

## Design review (Fable, 2026-09-26)

Changed after review: holdings are read through the sync's adapters with
previous tokens and carryForward, not `lookupWallet` (#1); movements come
from quantity changes over a snapshot that keeps unrecognized/dust rows,
with venue cash excluded and perps/predictions keyed by venue identity (#2);
quantities per coin are summed across chains, receipts keep their own key
(#3); the cron claims and drains within one invocation, primes prices once,
and runs at its own hour (#4); every snapshot write goes through one
refresh function (#5); shared tables are readable only by an address's
watchers (#6); caps are a database trigger (#7); EVM addresses are
lowercased (#8); watched coins stay out of Refresh prices (#9); storage
recomputed against the real headroom, with retention and an app-wide cap
(#10); phase 3 fields (`watched_positions`, nullable prices, wallet total per
movement) and the early/late and cash-ratio data sources are named (#11).

## Phase 1 notes (2026-09-26)

- First real address (a heavily airdropped EVM wallet): 580 counted
  holdings, 3,992 unrecognized tokens — a full snapshot was 593 KB. The
  snapshot now keeps holdings ≥ $1, positions, and anything stored last
  time; dust and spam are only counted (63 KB for the same wallet; 254 rows
  kept, 326 dust). The read took ~2m20s.
- Found, not fixed (a pricing rule, owner's call): airdropped junk that
  CoinGecko prices dominates such a wallet's value (a 10B-token airdrop
  "worth" $339K), and a spam token on Berachain that answers the ERC-4626
  interface was valued as its "underlying" ($235K "BTC (as WBERA)").

## Phase 2 notes (2026-09-26)

- Cash-like coins: `coin_categories` has only 19 rows, so no stablecoin list
  exists. A coin counts as cash when it's within 2% of $1 and moved under 2%
  over 7 days and 3% over 30 (asset_prices) — `watchRefresh.ts` `isCashLike`.
- Movements are only reported when they can be sized: an unpriced or
  illiquid coin's change is skipped (its quantity is still stored).
- Addresses read before phase 2 start their position history at their first
  read after it (recorded as held-at-start).

## Phase 3 notes (2026-09-26)

- Built before any movement history existed (owner's call): the movement
  sections say so and fill in from the second daily read. "Held by several
  right now" works from snapshots on day one (first result: ETH held by 3 of
  6 influencers).
- Cross-group notes appear only when one group is selected.
- Early/late reads each traded coin's stored price history; coins without
  30 days of history before the entry show "—" (a CoinGecko backfill for
  them would be a budgeted decision, §5).

## Phase 4 — Activity check (plan, 2026-09-28)

### Goal

The owner at their desk mid-day: "since this morning's 08:00 read, has
anyone I watch bought, added, trimmed or sold?" — in seconds, on demand,
without re-reading every balance. Nothing runs in the background (owner:
"if I'm not looking at the app, it doesn't matter when the scan runs"). The
daily full read stays the source of truth.

### Decisions (owner, 2026-09-28)

- On demand only: an **Activity check** button on the Dashboard's Wallet
  Watch panel and on Wallet Watch (the selected group's addresses).
- Results are **saved until the next morning's read** and **appended** by
  later checks, never overwritten.
- Each check reads only **since its own last check** (a cursor per
  address), but lines are judged on **the whole day** against the morning
  snapshot — two 3% adds are one 6% line.
- Same bar as the daily read: ≥ $100 and (≥ 1% of the position or ≥ $5,000).
- Each line shows the trade's price, the price now and the change
  (as the feed already does).

### Sources — checked live 2026-09-28 on the watched wallets

| Wallets | Source | Live result |
|---|---|---|
| EVM (8 addresses, 1–27 chains each) | Alchemy `alchemy_getAssetTransfers` (existing `adapters/alchemy.ts`), from/to, `external`+`erc20`, from the cursor block; only chains in the morning snapshot that Alchemy serves (`ALCHEMY_HOSTS`) | ~0.9 s per chain, 2 calls; VirtualBacon's AURORA sale found at 11:47 UTC with the exact quantity the 17:12 full read later recorded |
| Solana (11 addresses) | Helius Enhanced Transactions `GET /v0/addresses/{a}/transactions` (100 per page, `until=<signature>` cursor) | 0.6–1 s per page; `until` returns exactly the newer ones. **7 of 10 gem wallets had 95–100+ transactions in 24 h** — mostly spam drops, NFT bids, pump.fun noise; a handful of real swaps |
| Hyperliquid (3 venue accounts) | `userFillsByTime` from the cursor time | ~0.6 s, 1 call, free |
| Bitcoin (1) | Blockstream (existing `bitcoinTx.ts`) | 1 call |

EVM chains Alchemy doesn't serve (PulseChain, Merlin, Manta, …) and other
venues (Lighter, Aster, Polymarket) are **not checked** and named as such;
the 08:00 read covers them.

### How a check works

1. Claim nothing, poll nothing: a route handler (`api/wallet-watch/check`,
   outside the Server Action queue) streams one NDJSON line per address as
   it finishes, like Refresh positions — so no status checks at all.
2. Per address, read from its cursor to now (never checked: newest-first
   back to the last read's start), paging (Solana up to `MAX_PAGES` = 5, i.e. 500
   transactions; past that the address is named "too busy — see the
   morning read").
3. Reduce each transaction to **net quantity change per coin for this
   address** (Helius `tokenBalanceChanges`/`nativeBalanceChanges` for the
   owner; Alchemy's in/out legs). This ignores the transaction's label, so
   pump.fun "UNKNOWN" swaps count and spam that nets to a coin we don't
   price is dropped. Contracts/mints resolve to a `price_key` the same way
   a sync does (`withPriceKeys`); an unpriced, unlisted coin is skipped
   (as the daily diff skips it).
4. Classify: a transaction with an out leg and an in leg is a **swap**
   (bought/sold; its price = the other leg's value ÷ quantity when that leg
   is SOL, ETH or a stablecoin); a one-legged transaction is a **transfer**
   ("received"/"sent"), never called a buy or sale. Transfers between two
   addresses of the same influencer net to zero.
5. Save the per-coin legs (appended to `tx_activity`, keyed by transaction),
   move the cursor. A source that fails leaves the cursor where it was and the
   address is named "not checked" — never shown as "no activity" (§4.3).
6. The feed recomputes the day's lines per influencer: sum of today's rows
   per coin vs the morning snapshot's quantity, same rule as `watchDiff.ts`
   (shared pure function), marked "since 08:00 · from transactions", with
   lines new since the previous check highlighted.
7. The next read (08:00 or a Refresh) makes the official movements from
   balances, drops the legs before its start time, and keeps the cursor
   (a position in the chain's history, not a day). See review items 2–4.

Shared per address, like `watched_addresses`: a check by any user updates
the rows every watcher sees, and an address checked in the last 5 minutes
is reused, not re-read.

### Data model (SQL handed over before code; revised after review)

No new table: the day's activity is a cache that the next read replaces, so
it lives on the shared `watched_addresses` row (existing RLS, one write per
address):
- `tx_activity jsonb` — the day's per-coin legs found by checks since the
  last read's start: `{txId, assetKey, sourceChain, priceKey, ticker,
  qtyDelta, kind: "swap"|"transfer", counterparty, priceUsd, at,
  checkedAt}`; appended (deduped by txId + assetKey), never overwritten.
- `tx_cursor jsonb` — where the last check stopped, per source (EVM chain →
  block, `sol` → signature, `hl` → fill time). Never a day boundary.
- `tx_checked_at`, `tx_check_status`.
The day boundary is the last read's **start** time, stored in the snapshot
(`snapshot.readStartedAt`, no column).

### Budget (per check of all 19 addresses, measured counts above)

- **Helius:** 1–5 pages per busy Solana wallet on the first check of the
  day, ~1 on later ones → ~15–25 calls. Enhanced Transactions are priced
  per call in Helius credits (published rate 100 credits/call — to confirm
  on the Helius dashboard before build).
- **Alchemy:** 2 calls per checked chain → ~70 (Vitalik alone is ~40); a
  few thousand compute units, against 30M/month free.
- **Hyperliquid, Blockstream:** 4 free calls.
- **CoinGecko:** 0 (prices from `asset_prices`; a coin never priced before
  goes through `ensureAssetPrices`' one batched call).
- **Supabase:** ~5 requests per check (read snapshots + cursors, one
  transfers upsert, one cursor upsert, one read for the feed) and no
  polling.

### At 10× (190 addresses)

A full check becomes ~1,000 external calls — so a check is per **group**
(the selected one), addresses are shared across users with the 5-minute
reuse, and Alchemy chains are limited to the ones in the morning snapshot.
Helius credits are the first limit to watch.

### What fails and how it shows

A source error: that address "not checked (Helius: …)", cursor unmoved. A
wallet over the page cap: "too busy". A chain with no source: "not checked
— covered by the 08:00 read". A transfer we can't price: not shown (like
the daily diff). A transfer to an exchange: "sent", not "sold".

### Gate

Unit tests for the reduction (swap vs transfer, same-owner netting, the
day's cumulative rule, a failed source never reads as empty). Then two
real checks on the owner's list: every line checked against Solscan /
Etherscan for three wallets, and the next morning's read confirms the
day's lines (same coins, same direction).

### Design review (Fable, 2026-09-28) — adopted

1. **EVM sales for ETH.** `alchemy.ts` reads only `external`+`erc20`;
   routers pay ETH out as internal transfers. Request `internal` on each
   chain whose Alchemy host accepts it (checked live per host at build);
   elsewhere a token-out with no other leg in a DEX transaction is "sold —
   ETH leg not tracked", priced from `asset_prices`, never "sent".
2. **Cursor ≠ day.** The cursor is only where the last check stopped. The
   day is a time filter on `at` (≥ the last read's start). A never-checked
   address pages newest-first until it crosses the boundary, then sets its
   cursor.
3. **Boundary = the read's start.** `refreshWatchedAddress` stamps
   `snapshotAt` after the balances return (reads take minutes), so a trade
   inside the read would be in neither. The boundary is the read's start
   time (an overlap double-counts for at most a day; a gap would hide a
   trade).
4. The hand-off lives in `refreshWatchedAddress` (every snapshot write, a
   Refresh included): it drops `tx_activity` legs before its start. The feed
   also filters `at ≥ boundary`, so a late check write can't double count.
5. A check claims each address compare-and-set on `tx_checked_at` (the
   reuse window), like `claimWatchedAddresses`; a chain's cursor moves only
   after its calls all succeeded and its legs are saved.
6. Coins whose snapshot rows are `kept` (a failed source this morning) are
   not sized — as `diffSnapshots` skips them.
7. Same-influencer netting happens at feed time (influencers are per user;
   the row is per address): each leg stores its `counterparty`.
8. Page cap (Solana 5 pages, Alchemy `maxCount` 100 × 5): the cursor moves
   to the newest anyway, what was read is saved, status "partial — N+
   transactions".
9. Solana fees and rent are added back to the fee payer's SOL change; a SOL
   change under a small per-transaction floor with no other leg is ignored.
10. **Helius budget:** ~20 calls × 100 credits per check; at ~10 checks a
    day that's ~600K credits a month — most of a free plan, shared with
    wallet syncs. Capped: a 15-minute reuse window per address, checks run
    on the selected group only. The owner confirms the plan's credits first.
11. Supabase: streaming writes per address — about 2 requests per address
    plus 3 (~40 for 19 addresses), no polling.
12. `assetKey` uses `watchDiff.ts` `assetOf`'s rule on a SnapshotRow-shaped
    leg; wSOL/WETH key via `withPriceKeys` but count as SOL/ETH for the
    other-leg price.
13. Hyperliquid legs key by fill `tid`; a perp flip within the day is named
    (its key includes the side). Spot fills → `hl:<TOKEN>`.
14. "New since your last check" is per viewer (`usePersistedState`), not the
    shared `checked_at`. The route sets `maxDuration`; addresses it doesn't
    reach are "not checked". No token-registry refresh hook in the check.
15. Reorgs: re-read a couple of minutes of blocks behind the cursor
    (idempotent); the next read bounds any damage to one day.

## Phase 4 notes (2026-09-28)

- Built as reviewed, except: **Hyperliquid and other venues are not
  checked** in this version (their perp rows' keys differ from fills', and
  no watched wallet had an open perp) — named "not checked"; the morning
  read covers them. "New" marks lines found by the latest check (shared),
  not per viewer.
- Live, read-only, before shipping: a busy gem wallet's 24 h = 170 coin
  changes in 2.5 s (3 Helius pages), 22 real swaps priced from their SOL
  leg, 120 spam transfers dropped; a coin bought three times and sold the
  same day netted to no line. VirtualBacon's AURORA sale read on Ethereum.
- Shipped before a full check ran end to end (owner: still in dev). Gate
  still open: the first real checks vs Solscan/Etherscan for three
  wallets, and the next morning's read confirming the day's lines.

## Phase 5 — Live activity via Helius webhooks (plan, 2026-09-28)

### Goal

A watched wallet's trades appear in its activity within seconds, without
anyone pressing Refresh activity and without polling — for the wallets the
owner chooses (start: the **Swing traders** group). Owner, 2026-09-28: "I
don't want to burn my tokens trying to constantly refresh."

### How others do it

KOLScan, GMGN and Cielo index every swap on the big DEX programs from their
own nodes / Geyser (gRPC) streams and filter by wallet — too big for us.
Per-wallet push is the right scale here: a Solana node or provider tells us
when a watched address is in a transaction. Options: RPC WebSocket
`logsSubscribe` (needs an always-on process — Vercel can't hold one),
Geyser/LaserStream (paid, ~$50–500+/month), or **Helius webhooks**: Helius
POSTs each transaction touching the listed addresses to our route. Chosen:
webhooks — no extra server, and they fit Vercel.

### Costs (checked 2026-09-28, Helius docs + the owner's dashboard)

- **1 credit per delivered transaction**; **100 credits per webhook
  create/edit/delete**. Available on the free plan (0 used this cycle).
- Swing traders: a few transactions a day each → ~150–300 credits a month
  for the group. A busy meme wallet (Hash): 100–300 a day incl. spam →
  3,000–9,000 a month — why live is opt-in per group, not everyone.
- Supabase: each delivery = one read + one write of the address's
  `tx_activity` (~2 requests); swing wallets → a few dozen a day. Budget
  it (CLAUDE.md §5) before turning live on for meme wallets.
- No Enhanced Transactions (100 credits): the **raw** webhook carries
  pre/post balances, reduced by our own code.

### Design

- **One webhook** (type `raw`, network mainnet) for every address in a
  live group, owned by the app: `webhookSync.ts` creates it the first time
  and edits its address list when a live group's membership changes (100
  credits per change; changes batched — one edit per save).
- **Route** `POST /api/wallet-watch/webhook`: checks Helius's
  `Authorization` header against `HELIUS_WEBHOOK_SECRET` (set on the
  webhook; the route rejects anything else), then for each transaction:
  reduce to `RawChange`s from `meta.preTokenBalances/postTokenBalances`
  and `preBalances/postBalances` for the watched owner (the same net-change
  rule as `readSolana`, fee added back), identify coins, and append legs to
  that address's `tx_activity` (`appendLegs` — deduped by transaction, so
  Helius's retries and duplicates are harmless). The cursor moves forward
  too, so a manual check never re-reads what the webhook saved.
- **Opt-in per group**: a "Live" switch on a Wallet Watch group
  (`watch_groups.live boolean`). The webhook's address list = addresses of
  influencers in any live group, across users (shared rows, like reads).
- **Display**: the activity panel says "live" for those wallets and shows
  new lines on the next page load or refresh (Supabase Realtime push to
  the open page is a later step — it adds its own request budget).

### What fails and how it shows

Webhook down or disabled by Helius (it auto-disables failing endpoints on
paid plans): the panel's "last delivery" time goes stale and Refresh
activity still works (same legs, same cursor). A bad signature: 401, logged.
A transaction for an address no longer live: ignored. Our route erroring:
Helius retries; duplicates dedupe.

### Data / SQL

- `watch_groups.live boolean not null default false`.
- `watched_addresses.live_last_event_at timestamptz` (staleness caption).
- Env: `HELIUS_WEBHOOK_SECRET` (and the webhook id is stored in a
  one-row `app_settings`-style table or env `HELIUS_WEBHOOK_ID`).

### Gate

Unit tests for the raw-transaction reduction (a pump.fun buy, a sell, a
transfer, a failed transaction, a duplicate delivery). Then turn Live on
for Swing traders only; for two days compare every delivered trade with
KOLScan/Solscan and with Refresh activity (same lines), and read the
Helius dashboard's event count against the estimate.

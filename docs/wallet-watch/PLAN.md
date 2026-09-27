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
  5% of the previous quantity and at least $100 (named constants).
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
4. **Later:** alerts (Discord, reusing `hold/signal-alerts`),
   transaction-level trades, shared/public groups.

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

# Reading prices for a page — design (draft for Fable's review, 2026-09-29)

## Goal

A page render reads the prices it shows in the call it already makes, sized
by what the page shows — not the whole `asset_prices` table. Keep every page
at ≤ 2 serial round trips (CLAUDE.md §6), add no Supabase request per view,
and never show "—" for a coin that has a price (§4.1).

## Where we are (measured)

- Every page render calls `asset_market_rows()` (`queries.ts`
  `getAssetPriceRows`): all 2,050 `asset_prices` rows joined to `assets`,
  ~147 KB gzipped, ~730 KB of JSON. The price map, the asset stats and the
  perp marks are built from it; ~30 call sites read those maps without
  saying which coins they need.
- Production `[render]` lines, 2026-09-29 18:33 UTC (functions in pdx1,
  database in Oregon): the prices call was the slowest request on 5 of 9
  renders — 230, 294, 357, 683 ms (cold) — against 166–325 ms for the
  wallets-with-holdings read and 214 ms for the price history.
- From outside Vercel (Phoenix), the same call is ~250 ms for 1 coin and
  ~420 ms for all of them: roughly 170 ms of the cost is building and sending
  2,050 rows.
- The owner holds ~76 coins; all users together hold 345 distinct price keys.
  The rest of the table is watchlist coins, Wallet Watch coins and history.
- 4 of 9 renders ran on a new server instance (`cold`). A cold one-row read
  took 659 ms. The sidebar prefetches ~25 routes at once on each full page
  load (a function invocation each, no Supabase request) — plausibly what
  starts the extra instances.

## How others do it

- **Zerion, DeBank:** the portfolio API returns positions with the price
  already on each one; prices live in a server-side price service or cache,
  and a client never downloads a price table. The unit of truth is the
  position, priced by asset id at read time.
- **CoinGecko's portfolio:** the client asks for prices of the portfolio's
  coin ids only (`/simple/price?ids=…`).
- Common thread: the read is scoped to the positions being shown, and cost
  grows with one user's positions, not with every coin anyone has.

## How it scales

The whole-table read grows with all users' coins, the watchlists' and Wallet
Watch's: at 10× users, ~20,000 rows ≈ 1.5 MB per render, on every page view,
for every user. A read scoped to the page grows with one user's own coins.

## Options

**A. Precompute the whole table's JSON** (a cache row rebuilt when
`asset_prices` or `assets` change; the function returns it). No call site
changes and no correctness risk, but it still sends everything and still
grows with all users. It fixes build time, not size or scale.

**B. The user's prices, found by the database** — `asset_market_rows_mine()`
(`security invoker`, RLS): the prices of the caller's holdings, watchlist
coins, and every `hlperp:` / `lighterperp:` mark row, in the same one call.
A portfolio page would use it instead of the whole table: same hop count,
~76–150 rows. Pages showing other people's coins (Wallet Watch, Watch
Insights, `/lookup`, the Dashboard's watch feed, admin, crons) keep the full
read or their own scope. Risk: a page on B that shows a coin outside
"mine" shows "—".

**C. Embed the price in the holdings read** — a PostgREST computed
relationship (`holdings` → its `asset_prices` row by `price_key`), so
`wallets?select=*,holdings(*,price:asset_prices(...))` returns each holding
priced, in the request the page already makes (zero extra requests or hops).
The price map for the portfolio is built from those rows. The watchlist's
items embed theirs the same way. What's left (watch feed, marks) still
needs a scoped read. This is Zerion's shape.

**D. Next's cross-request cache** — rejected on 2026-09-29 (in-memory
entries don't survive between serverless instances, the remote variant costs
a lookup, and it touches all 41 pages).

## Recommendation (for review)

B or C for the portfolio pages, plus a guard that makes the risk visible:
the scoped price map records every lookup of a key it doesn't hold, and the
`[render]` line reports `missing-price=<n>` — so a wrong scope shows in the
logs on the first render, not as a silent "—".

Rollout: one page family at a time (Assets/Portfolio/Wallets first, then
Dashboard, Analytics, Performance), each checked with the page comparison
used in phases 2–3 (rendered values before and after, identical).

## Also in scope: cold starts from prefetch bursts

The sidebar's `<Link>`s prefetch every route on load. On Next 16.3.4 with
`force-dynamic` pages, a prefetch fetches the route's loading shell (the
skeleton), which is what makes a click show the skeleton at once — the
owner requires that. Question: can prefetching be kept for the skeleton
while avoiding ~25 simultaneous function invocations (hover or viewport
prefetch, or a static shell served from the edge)?

## Verification gates

1. `missing-price` stays 0 on every page in the logs for a day.
2. Page comparison identical (rendered values) for each migrated page.
3. `[render]`: the prices call's time on warm renders; requests per view
   unchanged or lower.
4. Supabase requests a day (Logs Explorer) and Vercel invocations (Usage)
   before and after.

## Cost of each option (to fill in from the review)

Time saved, Supabase requests and transfer, Vercel invocations and
transfer, external API calls (none), tokens (this review).

## Fable's review (2026-09-29) — the plan

- **Pick B, reshaped:** `my_market_rows(p_watch boolean)`, security invoker,
  one call in parallel with the wallets read. Its coins: the caller's
  holdings, watchlist coins, every `hlperp:` / `lighterperp:` / `asterperp:`
  mark row, and with `p_watch` the Wallet Watch coins the caller can see
  (`watched_movements.price_key`, snapshot rows, `tx_activity` legs).
  Pages that read another user (admin) or everything (crons, directory)
  keep the full read; server paths whose keys are known use
  `asset_market_rows(p_keys)`.
- **RLS:** `asset_prices` and `assets` are granted to service_role only, so
  a security-invoker function would be denied. Grant signed-in users select
  (as `price_history` / `asset_price_daily` do), with `asset_prices` limited
  to its price columns (not `last_error` / `last_attempt_at` /
  `missing_since`). Add an index on `holdings(wallet_id)` for the RLS
  check.
- **The guard, corrected:** the function returns one row for every one of
  the user's coins, priced or not (left join). So a key missing from the
  map can only be a scope bug (logged as `scope-miss` on the `[render]`
  line), and a key with a null price is simply unpriced. Marks are exempt
  (missing until Refresh prices stores one). `ensurePriced(keys)` fetches
  keys outside the scope that a page knows it needs (Transactions' native
  coins) in the second hop.
- **C** (embedding) gains ~0 ms: prices already load in parallel with the
  wallets read, which bounds the span. **A** fixes build time only.
- **Prefetch:** on this setup (force-dynamic pages, no Cache Components)
  there is no way to prefetch the skeleton with zero function calls. The
  documented cut is hover prefetch on secondary links: the skeleton then
  appears one server response (~0.1–0.3 s warm) after the click instead
  of at once. Check Vercel's Fluid Compute setting first (one instance
  serving many requests absorbs the burst). Prefetches make no Supabase
  request: the 17:24 burst on 2026-09-29 logged no `[render]` lines.
- **Estimates:** ~150–400 rows instead of 2,050 (~10–25 KB instead of
  147 KB compressed); the prices call ~90–150 ms warm; a page is ~60–200 ms
  faster where prices was its slowest call (5 of 9 renders), ~0 elsewhere,
  since the wallets read (166–325 ms) then bounds it. Supabase requests
  unchanged; ~125 KB less transfer per render; at 10× users the read stays
  per-user.
- **Phases:** 0 SQL (grants, function, index; EXPLAIN ANALYZE < ~30 ms) ·
  1 portfolio pages · 2 Wallet Watch pages · 3 server paths on `p_keys` ·
  4 hover prefetch (if chosen).

## Shipped (2026-09-29)

- Phase 0: grants, `holdings_wallet_idx`, `my_market_rows` — 9 ms (304
  coins) / 13 ms (609 with Wallet Watch) as the owner, against 43 ms for
  the full read (the first, cold run took 182 ms).
- Phase 1: Assets, Portfolio, Wallets, a wallet, DeFi, Performance,
  Analytics, Watchlist on `scopePricesToUser()` — pages byte-identical,
  no scope misses in production.
- Phase 2: Dashboard, Wallet Watch, influencer pages, Watch Insights on
  `scopePricesToUser(true)` — 22 pages identical, no misses.
- Phase 3: `getMarketFor(keys)` (`asset_market_rows(p_keys)`, one request
  for prices and stats) in the morning Wallet Watch read (was two full
  reads per address), the address lookup (identical to the old code on a
  live address) and a user's snapshot after Refresh prices. A lookup
  outside the keys logs `scope-miss outside a render`. Left on the full
  read: the shared influencer link (rare; its coins come from parallel
  reads), admin pages, the daily snapshot cron, the directory.

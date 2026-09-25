# Decisions log

Why the rules in CLAUDE.md exist: the incident or reasoning behind each, newest
first. Dates are UTC. CLAUDE.md states the rule and links here as
`(DECISIONS: <date> <title>)`; this file keeps the story so the rule itself can
stay short. Add an entry when a
rule is added or changed because of something that happened. Entries dated
"before 2026-09-22" predate this log and carry no exact date.

---

## 2026-09-25 — Wallet balance discovery

The sync read every CoinGecko-listed token on every chain (tens of thousands of
`balanceOf` calls per wallet): slow, blind to unlisted tokens (Blast's hUSDB,
Taiko's aTkoWETH never showed), and prone to "N balance checks unverified".
Leaders (Zerion, DeBank/Rabby) ask an indexer what the address holds, then read
balances. Measured on 20 Alchemy chains (phase 1): Metamask Main 5.9s → 1.9s,
BizNFT 5.4s → 3.7s; Alchemy missed only $0 dust; vitalik.eth needs 106 pages,
hence the page cap with a registry fallback. Owner decisions: receipts CoinGecko
doesn't list are valued as their underlying; unrecognized tokens go to their own
table (`wallet_discovered_tokens`), never into totals. Phase 3's dry run over
every EVM wallet (`scripts/diag/discovery-dryrun.ts`) caught a bug before it
shipped: a receipt priced as its underlying looked "tradable" by the underlying's
volume, which would have kept the token and dropped its protocol position.

## 2026-09-25 — Design a core subsystem before building it

In one day three core pieces were rebuilt after their first design hit its
limit: pricing (ticker-keyed stores → one price per asset), DeFi (a separate
sync → part of the wallet sync, receipt dedupe), and balance discovery (a
fixed chain list × CoinGecko's token list → the detect-then-scan / indexer
redesign). Each first version was the simplest thing that worked for the owner's
data; the owner asked "how do we reach this design from the start". Leading
products (Zerion, DeBank/Rabby) use indexers and "chains this address used"
detection — known patterns we reached late. Pricing went smoothly because it had
a researched plan and a Fable review first; the others didn't. Hence the
CLAUDE.md rule: research how the leaders do it, prefer an existing service,
stress-test at 10×, Fable-review the doc, then build.

## 2026-09-25 — DeFi positions are part of the wallet sync; receipts count once

BizNFT showed ~$5,350 more than DeBank. Two double counts: Hyperliquid perps
margin stored as "Perps Available" and again per position (fixed in
`hyperliquidPerps.ts`), and liquid staking receipts (MaticX, eETH, mDEGEN)
counted as a wallet token and again as Zerion's staking position, whose pool
contract is that token. Owner rule: a receipt you can trade without unstaking is
a token; one you can't is shown as the position, with where it's staked and how
to withdraw (tradable = CoinGecko 24h volume, `receiptDedupe.ts`). The first
version compared against the other sync's saved rows, so the result depended on
which button was clicked last — "horrible user experience" (owner). Zerion's
DeFi fetch moved into the wallet sync and the separate DeFi Sync button was
removed, so both lists are compared in memory in one job. Owner: no rate limit
for now (two users); native adapters take precedence and Zerion skips their
protocols. Vault shares Zerion reports without a pool address (Morpho's
mDEGEN — Zerion's own totals count them twice too) are linked by reading the
vault on-chain (ERC-4626 `asset()` + `convertToAssets`) and requiring the
amounts to match; it runs while Zerion loads (~0.8s for 29 candidates).

## 2026-09-25 — Analytics: chain returns across the estimate→real switch

The performance chart stitches an estimate (today's holdings × past prices) in
front of real daily snapshots. The estimate leaves out every coin without price
history, so where real snapshots begin the line steps up. The range change
subtracted first from last, which counted that step as gain: +$142,683 / +41.56%
on a 30-day view that was really +18.70%. `rangeChange` (`src/lib/chart.ts`) now
chains the two parts' own returns, (1+r_est)(1+r_real)−1, and marks it with `*`.
Same day: the coverage caption read 99% because a daily close from today counted
as "history". A coin is now covered only if it has a price before the first real
snapshot (`estimateCoverage`'s `before`).

## 2026-09-25 — One price per asset (pricing redesign)

MORPHO showed +13.89% / $2.42 on holdings and −5.6% / $2.75 on the watchlist at
the same moment (`docs/pricing/PLAN.md`), because the app had five price stores
(ticker-keyed `prices`, sync-time `usd_override` stamps, `token_registry` stats,
`coin_market_data`, `coin_cache`). A coin could be
valued off an unrelated asset sharing its ticker, and the same coin could get
different prices on different pages. Replaced by `price_key` on every holding and
one `asset_prices` row per key (plan, owner decisions and phases:
`docs/pricing/PLAN.md`). Owner decisions: refresh is on demand (button, after a
sync, before the daily snapshot if older than 6h) — no periodic refresh; bridged
and wrapped copies (WETH, USDC.e, axlUSDC) and liquid staking tokens keep their
own prices, and combining them is display-only; a manually entered quantity must
pick its coin. Verified with per-user totals before and after every phase
(`scripts/diag/portfolio-totals.ts`).

## 2026-09-25 — Fix the category, not the instance

Seven exchange tickers (Kraken's ETH2, XDG, SOL03.S, USDG, BABY; Coinbase's
RNDR, RONIN) were fixed by hand-inserting `exchange_assets` rows. The owner
objected: other users bring different tokens, so hand fixes don't scale.
Afterwards: exchange tickers come from CoinGecko's per-exchange data, refreshed
weekly (`adapters/exchangeTickers.ts`); Kraken staking codes resolve by Kraken's
own naming (`krakenStakedBase`); Cosmos IBC tokens are traced to their home chain
(`cosmosMulti.ts`); `/admin/pricing` shows every unpriced holding across all
users by cause. Hand rows are labeled "Set by hand (stopgap)" in Settings.

## 2026-09-25 — The token list refreshes itself

"Refresh token list" was an 80-second button a user had to remember. Replaced by
a weekly cron and a refresh (at most daily) when a Solana/Sui sync meets a token
the list doesn't know (`lib/tokenRegistryRefresh.ts`). The app is not meant to
be a coin database the user maintains.

## 2026-09-24 — A failed part of a sync kept deleting its rows

A sync replaces a wallet's rows in one atomic RPC, so a source that soft-failed
and returned `[]` erased its own rows: 385 staked AXS vanished on a CoinGecko
429. Every soft failure now also returns a `KeepScope` (`src/lib/carryForward.ts`)
naming the rows it owns, which are re-saved from the last run.

## 2026-09-24 — SQL handed over in the `public` schema

`signals_load_log` DDL was written as `public.` and the insert failed with "Could
not find the table 'cryptoport.signals_load_log'" — the clients are pinned to the
`cryptoport` schema. `scripts/check-sql-schema.mts` now fails on anything outside
it, and every handover runs through it.

## 2026-09-24 — `git reset --hard` wiped a local-only file

Moving a commit to a hold branch with `reset --hard` silently discarded the
owner's uncommitted `next.config.ts` change (`allowedDevOrigins`); it was
recovered only because its diff was in the session transcript. Hence status →
stash → stash list before any destructive git command.

## 2026-09-23 — A hold shipped with an unrelated push

Screener 2b was "held" on `main` pending the first 07:00 cron check; an unrelated
"go ahead and push it" for `/signals` deployed it, and the cron tested 2b instead
of 2a. Holds now live on local `hold/<name>` branches and a general push never
releases one.

## 2026-09-23 — `revalidatePath` of a literal path skips dynamic sub-pages

A finished sync left `/wallets/<id>` stuck on "Syncing…": `revalidatePath("/wallets")`
refreshes the UI only when viewing that exact path. `notifyJobsComplete()` uses
`revalidatePath("/", "layout")`.

## 2026-09-22 — DDL pushed before it was run (twice); a backfill blew the CoinGecko cap

Twice a push deployed code whose next cron wrote to a column that didn't exist
yet. Order is now: hand over SQL, wait for it to be run, pass the preflight, then
push. The same day a history backfill exhausted the primary CoinGecko key's
monthly quota; `coingeckoFetch.ts` fails over to the backup key on quota
errors, and did for the rest of that month. Hence: ask before any
CoinGecko call the agent runs, and check month-to-date usage before bulk runs.

## Before 2026-09-22 — Router Cache `staleTimes` and `after()` revalidation

Next 15+ defaults `staleTimes.dynamic` to 0, so every navigation re-ran every
query ("clicking Portfolio takes 7 seconds even though I was just there"). First
raised to 60s on the assumption that `revalidatePath` purges the client cache on
any change. Half true: an action's own synchronous `revalidatePath` does (and
purges every visited page), but a `revalidatePath` inside `after()` can never
reach the browser — Next attaches the purge signal to the action's response,
which has already been sent. Fixed with `JobPoller` detecting busy→done and
calling `notifyJobsComplete()`, which is what made 1800s safe.

## Before 2026-09-22 — searchParams changes showed no loading state

`loading.tsx` only shows its fallback on first entry into a route segment: its
Suspense boundary is keyed without search params
(`node_modules/next/dist/client/components/layout-router.js`,
`createRouterCacheKey(segment, true)`). A tab/filter/re-search click that only
changes a search param suspends inside an already-resolved boundary, and a
transition keeps the old content with no feedback. Hit twice (trend-finder's
market-cap picker, encyclopedia's tabs). Fix: a `<Suspense key={...}>` keyed by
the params, as in Next's own search tutorial.

## Before 2026-09-22 — Research artifacts silently re-ran on page load

`trend_explanations` used a 24h TTL, so whichever page load landed after expiry
paid a live ~20–30s Perplexity call — even for a token the user had searched
before ("I thought we said everything should be stored"). Now claim-and-store-
forever with an explicit Refresh (`token_analyses`, `trend_explanations`).

## Before 2026-09-22 — A slow awaited Server Action froze all navigation

Next runs Server Actions and client navigations through one sequential queue per
client (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`).
`backfillHistoryAction` awaited a multi-minute backfill and froze every click
app-wide; moved into `after()` like `syncWalletHoldings`.

## Before 2026-09-22 — `server-only` vs `node --test`

`server-only` throws outside Next's server bundle, which broke unit tests of
guarded files. The package's own `"react-server"` export condition resolves to a
no-op, so `npm test` runs `node --conditions=react-server --test` and files keep
the real guard. One real client-bundle leak had been caught only by review.

## Before 2026-09-22 — A heavy module held pure helpers

`walletAuth.ts` (viem/siwe/@noble/curves) also exported `pinnedWalletChain` /
`walletDisplayName`, so `(app)/layout.tsx` and `queries.ts` pulled the whole
crypto graph into every page load. Split into `walletDisplay.ts` (pure) and
`walletAuth.ts` (heavy, sign-in only).

## Before 2026-09-22 — Dashboard is a lens

A 30-day value approximation proposed for the Dashboard was redirected to
Analytics, which owns derived and historical calculations.

## Before 2026-09-22 — "The API doesn't have this data" was wrong twice

Both times the real cause was unbounded concurrent requests tripping a rate
limiter (Coinbase's Exchange API, CoinGecko's anonymous tier), found only by
calling the live endpoint under realistic load.

## Before 2026-09-22 — Verify before reporting

A Coinbase rate-limit bug and a Dashboard query against a table that didn't
exist yet were caught only by an explicit verify-against-real-data pass.

## Before 2026-09-22 — Duplicated fixes

A wallet-lookup query and a DB upsert's dedupe step were each re-fixed in more
than one copy before being unified.

## Before 2026-09-22 — Test-runner discovery and stray scripts

`diag_full_sync_test.ts` was picked up by `node --test` and reported as a failing
test. Untracked root-level scripts (including a bulk-delete dedupe script)
lingered after their job was done.

## Before 2026-09-22 — Reuse over rebuild

EIP-6963 multi-wallet discovery via `mipd` instead of a hand-rolled provider
listener; exchanges' own 24h-change fields instead of computing deltas.

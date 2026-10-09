# Decisions log

Why the rules in CLAUDE.md exist: the incident or reasoning behind each, newest
first. Dates are UTC. CLAUDE.md states the rule and links here as
`(DECISIONS: <date> <title>)`; this file keeps the story so the rule itself can
stay short. Add an entry when a
rule is added or changed because of something that happened. Entries dated
"before 2026-09-22" predate this log and carry no exact date.

---

## 2026-10-09 — Jupiter Earn from the Lend API; the Portfolio API is gone

Every Solana sync reported "jupiter positions: HTTP 503" for days. Not a rate
limit (headers showed requests to spare) nor an outage: Jupiter's docs no longer
list the Portfolio API, and both its endpoints 503 instantly. Earn — the only
Jupiter product in the owner's wallets — is read from the Lend API's
`/earn/positions` (checked live: 12.508 SOL vs the frozen 12.4906). Limit orders
and DCA moved to Trigger V2 vaults that need the owner's signed session, so
they aren't read; a user with them would need a connect flow like near.com's.

## 2026-10-08 — near.com is read through Confidential Intents' user session

near.com's balances aren't on any public chain: they sit in NEAR Intents'
private shard (its "internal network"), and intents.near's public balances for
the user's 0x account were empty — the $10 deposit went to an address the
bridge doesn't attribute to that account. 1Click's account API reveals them to
a User-Session token got by signing an empty intent. That token is read-only
(only GET balances/history accept it; moving funds needs a freshly signed
intent), so it's stored like an exchange key. The nonce layout came from the
official SDK (its deadline sits in the nonce — guessing it from the docs'
examples failed verification); the whole sign-in was checked live with a
throwaway key before the owner signed.

## 2026-10-06 — Copy contracts on coin rows: only addresses copied as written

The owner kept finding coins with no copy button (Watchlist, Encyclopedia):
those rows are a coin id, not a holding, so they had no contract. The coin's
contracts come from `token_registry` by coin id — but that table stores every
address lowercased (its lookup key). Lowercase is fine for EVM; a lowercased
Solana mint or Sui coin type is a different, wrong address. So EVM contracts
are offered as stored, Solana/Sui only from `contract_exact` (the address as
CoinGecko lists it, written by the token-list refresh since 2026-10-06, and
only when it matches the key), and a `jup:<mint>` coin's own mint. A wrong
address is worse than no button.

## 2026-10-06 — Perp Scout: a curated list, incremental scans, figures in %

- **The list is curated in chat, not found by the app.** The first in-app
  screen picked junk (100% winning weeks, no perp positions, ROI +995,700%);
  the owner: "I'm asking you to find them for me, then just add it to the
  list." The screen became a script (`scripts/diag/perp-scout-screen.mts`)
  and the stage-3 rules came from what the junk had in common.
- **Unified accounts keep cash in spot:** equity and returns use the whole
  account's value (`portfolio` allTime), not the perps margin (#1 read $1.1M
  instead of $6.1M).
- **Fills arrive newest first, same-millisecond pieces too:** re-sorting by
  time put pieces of one order backwards and produced closes with no open
  (1,766 broken position chains on one trader; the owner: "how can you close
  close close without any opens?"). `parseFills` reverses the list; books
  carry a version so old ones were re-read in full.
- **Scans read only what changed** after a trader's first full read (the
  owner: "shouldn't that delta be tiny?"), checked by replaying 72 h of real
  fills against a full read — identical.
- **Percentages over dollars** everywhere a trader's result is shown: their
  size isn't the owner's.
- **Tracked trades and the added-trader list live in `app_settings` rows**
  (no DDL), small and read once per page.

## 2026-09-29 — Page latency: one round-trip budget, measured on every render

**What happened.** Speed kept coming back one page at a time: Refresh prices
polling (9.9 s), the Dashboard re-render (~4 s on production), Wallet Watch
reads. Each fix removed one cause; nothing measured pages as a whole, so the
next slow page was found by the owner. Measured this day:
- The site's functions ran in Vercel's default region, iad1 (Washington, DC);
  the database is in West US (Oregon). The owner moved functions to pdx1.
- Every page waits through 5–11 serial Supabase round trips (locally, ~100 ms
  each): Dashboard 18 requests / 7 hops / 1.4–1.7 s of database time; Assets
  11/5; Portfolio 11/6; Wallets 11/5; a wallet 12/6; Performance 62/9 (2.3 s);
  Analytics 15/11 (2.2 s); Watchlist 10/6; Wallet Watch 13/5; an influencer
  18/6; DeFi 7/5.
- The main cause (Fable's review): every page reads two whole shared tables —
  `asset_prices` (2,050 rows) then `assets` (1,485) — 1,000 rows per request,
  each page waiting for the one before (5 hops); sections that don't need the
  holdings wait for them; the wallets read runs twice (two `cache()` keys).

**Considered and not done.** Next's Cache Components ("use cache"): stable in
16.3.4, but its in-memory entries don't survive between serverless instances,
the remote variant costs a lookup about as long as the one database call it
would replace, and adopting it touches all 41 force-dynamic pages. Streaming
alone: `router.refresh()` is a transition and shows no fallback, so it can't
shorten a refresh — only fewer round trips can.

**The rule** (CLAUDE.md §6, "Every page render has a round-trip budget"):
at most 2 serial round trips; independent reads start together; a shared
table over 1,000 rows is read in one round trip (an RPC), never paged in a
render. Every render logs `[render] <path> <load|nav|action> req= hops= db=`
(`renderMeter.ts`), and `renderBudget.test.ts` fails on a new paging loop.
And (CLAUDE.md §5): every diagnosis and proposal states the time it saves and
its effect on each limit — owner, 2026-09-29: "whatever the fix is needs to be
fast and future proof".

## 2026-09-29 — Extend before adding

**What happened.** The owner asked to see a KOL's trades over the last few
days (VirtualBacon's STATICS and BUCKET buys on Robinhood Chain were two days
old, so the day's activity didn't show them). Claude proposed a "Recent
trades" view on the influencer page and built it as its own panel: a second
per-coin table, placed next to the Activity table it copied, with its own
buttons, captions and caching. The owner's intent was to backfill the
activity itself — "we already have an activity table; the whole purpose of
recent trades is to backfill the activity". It was rebuilt as Today / 7 days
/ 30 days tabs on the Activity table (`4ea41e9`), keeping the stored trade
history underneath.

**Why it happened.** CLAUDE.md had rules for reusing code (UI primitives, the
duplication threshold, the Dashboard as a lens) but none for reusing a
feature: nothing asked whether an existing view could take the new data
before a new one was built. And the proposal named the new thing ("a Recent
trades view") rather than where it would appear, so the owner couldn't see
it would be a second table until it existed.

**The rule** (CLAUDE.md §7, "Extend a feature before adding one"): check
whether an existing page, panel or table already shows that kind of data and
could take the new part as a window, filter, tab or column; a new surface
needs a reason the existing one can't serve; a proposal says where the
feature appears and which existing feature it extends.

---

## 2026-09-26 — Supabase log ingestion: verify sign-ins locally, read shared tables less

The organization passed its Free Plan log quota (1.16 / 1 GB; this project
0.67 GB, Trace Two 0.49 GB). Measured in Logs Explorer over 24 hours: 12.9k
log lines, of which `/auth/v1/user` 3,845 plus the matching `auth_logs`
3,901 (~60%) — `auth.getUser()` called Supabase Auth on every request,
twice per page (proxy.ts and the page) and on every link prefetch and status
poll. Next: full reads of `token_registry` 727, `asset_prices` 580,
`exchange_assets` 548, `assets` 171, `asset_contracts` 137. csp-screener
(same project) adds ~43 lines a day.

- `getUser` and `proxy.ts` now use `auth.getClaims()`: the token's ES256
  signature is verified locally against the project's published key (cached
  10 min by auth-js). A forged token claiming a real user id was rejected on
  the dev server; a real sign-in and the admin email check worked.
  Trade-off: a deleted or banned user stays signed in until the current
  token expires (≤ 1 hour) instead of immediately.
- `asset_contracts` + `exchange_assets` are cached per instance for 5
  minutes and cleared when the exchange-mapping refresh writes; one
  `asset_prices` read per request serves prices, stats and perp marks.
- Not changed: `token_registry` reads (targeted per chain per sync).

## 2026-09-26 — Analytics: attribution, risk profile, holdings in context

The old Analytics page only charted value over time, so it became Performance
and `/analytics` was rebuilt as analysis (owner: "design it how you think").
Allocation by chain and coin already lives on Assets, so it isn't repeated.

- **Attribution is holdings-based**, from each asset's own 24h/7d/30d change
  against the live total minus the snapshot from that day. We keep no
  per-asset daily quantities, so trades and deposits can't be split apart;
  "everything else" says so instead of guessing. Adding wallets shows up
  there (the owner's 7d: +$19k price, +$235k everything else).
- **Risk uses the last 90 days that have prices**, not 90 calendar days: the
  stored history has a gap (backfills end 2026-09-11, daily closes start
  2026-09-25), and a return is only taken between consecutive days. Assets
  with under 80% of those days are listed as not modeled, never zero-filled.
  BTC is the benchmark because it's what a crypto portfolio's swings track
  (the owner's beta: 1.01 and 1.06).
- **Flags are observations with fixed thresholds** (`FLAG_THRESHOLDS`), not
  signals — the same line the screener and signals hold.
- Possible next step: a daily per-asset quantity snapshot would allow exact
  attribution (trades vs deposits); it needs a table and its own plan.

## 2026-09-26 — Refresh positions streams each account as it returns

The owner asked for Refresh positions to fill in the way Rabby/DeBank's sync
does — totals visibly counting up as each source returns — instead of one
wait for the slowest account. The Server Action became a route handler
(`api/positions/refresh`) that streams one NDJSON line per account, read back
from the rows it just saved (so what streams in is what the page shows after
its final refresh). A route handler rather than a streaming Server Action: it
stays out of the per-tab action queue (§6), and a plain `fetch` body reader is
the simplest stream a client can consume. No schema change.

## 2026-09-26 — Refresh positions keeps a venue for 30 days after its last position

Refresh positions only read venues with an open position stored, so closing
the last position on a venue and opening a new one later went unseen until a
full wallet sync. Owner's idea: keep such wallets in the refresh, dropped after
a quiet period. Made per wallet AND venue (wallet_venue_activity, last time a
position was seen), so a Hyperliquid-only trader's Lighter/Aster/Polymarket
accounts aren't pulled. 30 days over 14: each extra read is one light call and
only on a click, and it covers a trader pausing a few weeks.

## 2026-09-26 — Perp coverage: Hyperliquid HIP-3 markets, Aster, Jupiter in Refresh positions

Owner: every perp and prediction venue we scan should land in Open positions;
build out major missing ones. Rankings (Sep 2026, 24h volume): Hyperliquid,
tradeXYZ, Aster, ApeX, Lighter; prediction: Kalshi overall, Polymarket 96%+
on-chain. tradeXYZ is a HIP-3 market on Hyperliquid with its own margin
account — the adapter read only the main market, so HIP-3 money was missing
from totals, not just positions. Now all 11 Hyperliquid markets are read
(collateral USDC/USDH/USDe/USDT0; USDH added to the $1 stablecoin list); five
live HIP-3 traders' totals matched Hyperliquid's own perps total to the cent
on four and +0.18% on one, after switching "Available" from cross-margin
equity to the whole account's (isolated positions had left it short, −17% on
one). Aster via its public by-address RPC (aster_getBalance; unit-tested on
its documented shape — no Aster account among ours to check live). ApeX,
edgeX and Kalshi need the user's API keys: a separate, exchange-style
feature, not built. Jupiter Perps / Prediction join Refresh positions through
a protocol filter on replace_venue_holdings.

## 2026-09-26 — Open positions on the Dashboard, live PnL from the venue's mark

Owner: show every open perp position on the Dashboard so users are aware of
them, with Refresh prices updating their value, but no wallet re-scan. A
position's value in totals stays its margin (no double count); PnL is shown
beside it, computed as size × (mark − entry) from Hyperliquid's mark price
(metaAndAssetCtxs, one call, only while a position is open) when that mark is
newer than the sync. Checked live: our figure matched Hyperliquid's own
unrealizedPnl to the cent on both of BizNFT's positions (PONS −$72.43, while
the synced figure still said −$9.16). Applied in the shared holdings reads, so
the wallet and DeFi pages show the same number as the Dashboard (the rule that
a new metric isn't born on the Dashboard). Same day: Lighter added (its
orderBookDetails carries every market's mark price in one call), and a
position's Price column shows the mark instead of margin ÷ size, which had
read LIT-PERP at $0.96 against a $4.79 market.

Then "Refresh positions" (owner: positions are what some users watch most
closely; don't spend a full price refresh on them): re-reading only the venue
accounts with an open position and replacing that venue's rows is exact and
keeps totals right (on Hyperliquid and Lighter PnL lands in the account's cash
rows, so recomputing PnL alone couldn't). Measured: BizNFT's Hyperliquid and
Polymarket accounts in 2.0 s together. The dry run also exposed a leak in the
shared logo cache: symbols CoinGecko doesn't know (LQNA, LICKO) were searched
again on every sync; "no logo" is now cached and re-checked after 30 days.

## 2026-09-26 — Transaction history: errors were read as "no transactions"

Every transaction source turned its errors into [], and the sync deletes a
queried chain's rows before saving the fresh ones — so a failure erased that
chain's history. Checked live: 10 of the chains routed to Alchemy fail every
time (Transfers API not offered: Mantle, opBNB, Sei, Fraxtal, Mode, Metis,
Cronos; not enabled: Taiko, Merlin, Chiliz), and on Scroll, zkSync, Linea and
Avalanche Alchemy returns transfers with `metadata: null`, which the adapter
skipped — those chains had shown no history since they moved to Alchemy.
Now: failures throw, each chain tries Alchemy → Etherscan → Blockscout,
missing block times are looked up in one batched call, and a chain nothing
answers keeps its rows (status "partial — kept from last sync: …"). The
spam filter reads token_registry instead of calling CoinGecko per chain per
sync. Metamask Main went from 0 rows on Scroll/Linea/Avalanche/Blast to
128/72/39/60.

## 2026-09-26 — Signals candle cache: shared in Supabase, packed

A day and a half of real /signals loads (signals_load_log, 121 loads, 9 server
instances, 18 Hyperliquid 429s) replayed through the candle-cache planner: a
per-instance memory cache would have answered 55% of candle requests (61% less
Hyperliquid weight) — instances didn't live past a bar close, so 45% were cold
full fetches; a shared cache answered 74% (81% less). The owner chose shared,
conditional on the 500 MB database limit: one row per coin+timeframe with
candles packed as float64 binary (~5-8 MB for the 93 combinations seen, ~50 MB
if every Hyperliquid perp were viewed), each trimmed to its timeframe's window,
rows unused 14 days deleted daily. Memory stays the first tier. The load log
and its instrumentation are removed.

## 2026-09-25 — Discovery beyond Alchemy (phase 5)

The 18 chains Alchemy doesn't index were checked live: Blockscout's token list
works on Mode, Metis, Aurora and Merlin; Etherscan's free tier has no balance
endpoint (addresstokenbalance is API Pro) but its transfer history works on
Taiko, Mantle, opBNB, Fraxtal, Sonic and Sei; Taiko's, Manta's and
PulseChain's Blockscout hosts are dead or blocked. Etherscan's free key allows
3 calls/second: all 13 EVM wallets at once queued the last one 27 s, so
Etherscan discovery adds to the registry scan instead of replacing it and is
skipped when the queue is too long; Sync all's two-at-a-time EVM lane ran with
no skips. Found BizNFT's aTkoWETH on Taiko (the last DeBank gap). The dry run
also caught Aave debt tokens being read as receipts (variableDebtWrsETH on
Mode, +$3): debt tokens answer UNDERLYING_ASSET_ADDRESS like aTokens, so the
reader now rejects anything answering borrowAllowance and requires aTokens to
answer RESERVE_TREASURY_ADDRESS.

## 2026-09-25 — Jupiter Perps from Jupiter's perps API

Jupiter's portfolio API (beta) returned "Discriminant 225 out of range" for its
perps fetcher on every sync of one wallet from 2026-09-10 — a wallet whose only
perps accounts were four closed January-2024 positions — and on a live trader's
wallet with two open positions, so for every perps user the value was unknown.
Jupiter's own CLI reads positions from `perps-api.jup.ag/v2/positions`; checked
live against the on-chain Position account (side, entry, size, collateral all
match). That API is now the source (`adapters/jupiterPerps.ts`), and the
portfolio API's perps fetcher is skipped. Jupiter Perps carries ~80% of Solana
perps volume, so it's covered even though the owner doesn't trade it. The same
change retries the portfolio API once when one of its fetchers reports
Jupiter's own backend rate limit.

Same day, the retry wasn't enough: the portfolio API's prediction-market
fetcher reported Jupiter's rate limit on 8 of 13 Solana wallets (none of which
hold prediction positions), while Jupiter's documented Prediction API
(`/prediction/v1/positions`) answered all 13. It's now the source
(`adapters/jupiterPrediction.ts`) and that fetcher is skipped too.
Also: Helius failed the Solana stake-account lookup with "account index
service overloaded … use getProgramAccountsV2 with pagination". The shared
`getProgramAccounts` now uses V2 (same results on all 13 wallets), with the
one-shot method as fallback, for every on-chain Solana adapter.

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

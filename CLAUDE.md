@AGENTS.md

# CryptoPort — project guidance

Last verified against the code at commit `ea9e799` (2026-09-25). Every claim
below names a file or symbol so it can be checked; when you change the thing a
rule describes, update the rule in the same commit. The story behind a rule
lives in `docs/DECISIONS.md` (cited as `DECISIONS: <date> <title>`), not here.

## 1. Purpose

A multi-tenant, multi-chain crypto portfolio tracker: one place to see every
wallet and holding (**traceability** — where is my money), what changed
(**trackability**), and enough signal to make a buy/sell decision. Not a
trading platform, not a tax tool. Every feature serves traceability and
trackability first, and must work for users whose assets differ from the
owner's.

- **The Dashboard is a lens, not a workshop.** `/dashboard` only presents data
  other pages already compute (`AssetGroup`, `portfolio_snapshots`, …). If a
  Dashboard request needs a new metric, aggregation or data source, say so and
  build it as its own page first (Analytics owns historical/derived math), then
  have the Dashboard consume it. (DECISIONS: before 2026-09-22 Dashboard is a
  lens)
- **The screener ("Fundamentals" in the UI) is a verified research dataset with
  a risk filter, not a signal.** No new capability until evidence supports it.
  Its spec, phases and rules live in `docs/screener/` (start with SPEC.md's
  "Product" section). `src/lib/screener/*` is never imported by portfolio code
  (wallets, holdings, watchlist); the Encyclopedia reads it only through
  `src/lib/screener/assetView.ts` (`getAssetFundamentals`) and
  `src/lib/screener/labels.ts`.
- Signals / SMC (`src/lib/signals`, `src/lib/smc`) are pre-registered research
  (`docs/signals/`), not trading. Auto-trading is backlog and gets its own plan.

## 2. Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` (port 3000 may belong to an unrelated server — pass `-p <port>`; never `pkill -f`, stop by PID: `lsof -ti:<port> -sTCP:LISTEN \| xargs kill`) |
| Type check | `npx tsc --noEmit` |
| Lint | `npm run lint` |
| Unit tests | `npm test` (= `node --conditions=react-server --test`) |
| Production build | `npm run build` |
| SQL schema check | `node scripts/check-sql-schema.mts <file.sql>` (exit 1 on anything outside `cryptoport`) |
| Screener schema preflight | `node scripts/check-screener-schema.mjs` |
| Portfolio totals regression | `scripts/diag/portfolio-totals.ts save <f.json>` then `compare <f.json>` |

**Verification gate before every push:** tsc, lint, test; `npm run build` for
changes to routes, config or dependencies; the screener preflight for anything
touching screener code or its tables.

**Diag/one-off scripts** (`scripts/diag/`): tsx is not a project dependency —
use a cached copy (`ls ~/.npm/_npx/*/node_modules/.bin/tsx`) with
`NODE_OPTIONS="--conditions=react-server"`, and load `.env.local` before a
dynamic `import()` of anything touching `src/lib/supabase.ts` (see
`scripts/diag/portfolio-totals.ts`). Under tsx wrap the body in `main()` — tsx
compiles `.ts` as CommonJS, so top-level `await` needs a `.mts` file (or plain
`node` with relative `.ts` imports only). `src/lib/queries.ts` can't be imported
outside Next (its `auth.ts` import pulls in `next/navigation`) — read tables with
`serviceDb()` directly. Only real tests may match `node --test`'s discovery:
`*.test.ts`, `*_test.ts`, `*-test.ts`, `test-*.ts`, `test.ts`, or any file in a
`test/` directory — name scripts accordingly. Keep a diag script only if
it's read-only and reusable (arguments, not hard-coded ids); delete one-offs;
never leave a destructive script anywhere.

## 3. Directory map

- `src/app/(app)/` — the app's pages (the nav list is
  `components/layout/navItems.tsx`). Every page renders per request and is
  viewable as a guest, except `admin` (`requireAdmin()` in
  `src/lib/adminAuth.ts` → `notFound()` for anyone but `ADMIN_EMAIL`).
  `wallets/actions.ts` holds the sync and price-refresh actions. Also
  `src/app/(auth)/` (sign-in) and `src/app/lookup/` (public address lookup).
- `src/app/api/` — `cron/{snapshot,screener-snapshot,token-registry}` (schedules
  in `vercel.json`, gated by `Authorization: Bearer $CRON_SECRET`),
  `job-status` (what `JobPoller` polls), `tv-symbol` (a route handler rather
  than a Server Action so it doesn't wait in the action queue, §6).
- `src/lib/` — pure logic (one concern per file, with a sibling `.test.ts`) plus
  the data layer (untested directly): `queries.ts` (page reads), `supabase.ts`
  (`serviceDb()` service role — shared tables, crons, admin only; `userDb()` —
  anything per-user, RLS applies), `auth.ts` (`getUser`, `requireUser`).
- `src/lib/adapters/` — one file per external source or chain (network code):
  EVM (`evm.ts` → `multicallEvm.ts`, chain list `evmChains.ts`), non-EVM
  (`nonEvmChains.ts`, `nonEvmDispatch.ts`), DeFi (`zerionDefi.ts` plus
  per-protocol files), pricing (`assetPrices.ts`, `assetKeys.ts`,
  `exchangeTickers.ts`), HTTP plumbing (`http.ts`, `coingeckoFetch.ts`,
  `jupiterFetch.ts`). Exchanges dispatch from `src/lib/exchangeAdapters.ts`.
  Where a topic has both halves, the pure part lives in `src/lib/` under the
  same name (`cosmosMulti.ts`, `exchangeTickers.ts`).
- `src/components/` — `ui/` (shared primitives), `jobs/` (background-job UI),
  per-page folders.
- `db/schema.sql` — checked-in documentation of the live schema (there is no
  migration tool; see §8). `scripts/` — schema checks, screener jobs, `diag/`,
  `launchd/` (the owner's local archive jobs).
- `docs/` — `DECISIONS.md` (why), `pricing/PLAN.md`, `screener/`, `signals/`.
  `BACKLOG.md` (repo root) is the committed backlog; read it before starting
  anything that might already be planned.

Env var names (values only in `.env.local` / Vercel): `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SITE_URL`, `COINGECKO_API_KEY`, `COINGECKO_API_KEY_BACKUP`,
`ETHERSCAN_API_KEY`, `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `ZERION_API_KEY`,
`JUPITER_API_KEY`, `PERPLEXITY_API_KEY`, `SECRETS_ENCRYPTION_KEY`,
`ADMIN_EMAIL`, `CRON_SECRET` (Vercel only); scripts only:
`SCREENER_ARCHIVE_DIR`, `SIGNALS_ARCHIVE_DIR`.

## 4. Data invariants — these must never break

### 4.1 Unknown is never 0

A missing value is **unknown**, never silently 0 and never a plausible-looking
wrong number. `valuation.ts`'s `Valuation` union (`{kind:"unpriced"}` vs
`{kind:"priced"}`) makes "forgot to handle missing data" a type error.
Unpriced holdings are counted and named, never dropped from totals silently;
averages (`blendedChange`) exclude missing inputs rather than treating them as
flat; the UI shows `—` or an explicit warning. Never fabricate placeholder data,
for guests included (§7).

### 4.2 Pricing: one price per asset

**Debugging a missing or stale value:** check the holding's `price_key`, then
that key's `asset_prices` row, then the latest `pricing_runs` row. Verify any
pricing change with `scripts/diag/portfolio-totals.ts save`/`compare`.

**Identity.** Every holding carries a `price_key`: the one asset it is — a
CoinGecko coin id, or `jup:<mint>` / `hl:<TOKEN>` / `coinbase:<TICKER>` /
`fiat:USD` for what CoinGecko doesn't list. `resolvePriceKey`
(`src/lib/assetIdentity.ts`; lookup tables loaded by `adapters/assetKeys.ts`
`withPriceKeys`) sets it at sync time:
- manual dollar entries and position values (`isPositionValue`) get none;
- then, in order: `asset_contracts` overrides; the row's own coin (Cosmos
  registry id, a manual pick); an exchange's fixed coins (`CANONICAL_EXCHANGE`,
  `NATIVE_BY_SYMBOL`); the venue's ticker map (`exchange_assets`) — an unmapped
  venue ticker tries `krakenStakedBase`, then becomes `coinbase:<T>` / `hl:<T>`,
  else stays unpriced; a contract via `token_registry` (CoinGecko's
  contract→coin list), with Solana falling back to `jup:<mint>`; the chain's own
  native coin (`nativeKey`, which also covers `PROTOCOL_COINS` and venue natives).
- **Never an open-ended ticker lookup.** The only ticker matches are those fixed
  sets and a chain's own native symbol; no match means unpriced.
- **Bridged and wrapped copies are their own assets** (WETH, USDC.e, axlUSDC,
  Gravity USDT). Combining liquid staking tokens with their base coin is a
  display toggle (`liquidStaking.ts`), never a price rule. A registry that maps
  a bridged copy onto the real coin (Keplr does) is not trusted for that asset
  (`registryAssetInfo`, `src/lib/cosmosMulti.ts`).

**Prices.** `asset_prices` holds one price per key plus its `change_*` and
`market_cap` columns, filled by `refreshAssetPrices` (`adapters/assetPrices.ts`)
in one lane per source — coingecko, jupiter, hyperliquid, coinbase — with
`fiat:USD` fixed at $1. A price is **never overwritten with null**
(`planPriceWrites` in `assetPriceWrites.ts` sets `missing_since` instead). Each
pass is logged to `pricing_runs` (keys requested/returned/missing, calls per
source).

**Refresh triggers** (owner decision: on demand, no periodic refresh): the
Refresh prices button; after a sync, only the keys it touched
(`ensureAssetPrices`, which skips keys fresher than its `maxAgeMs` default);
before a Sync all when the newest price is older than `primeSyncPricesAction`'s
threshold; before the daily snapshot when older than the threshold in
`api/cron/snapshot/route.ts` (`refreshAssetPricesIfOlderThan`).

**Valuation** (`valueHolding`, `valuation.ts`): `qty × asset_prices[price_key]`,
else the row's stored `usd_override`, else unpriced. `usd_override` is for
position values a protocol computes (LP, perps, Kamino, prediction shares,
vaults) and manual dollar entries. No sync path prices a coin row from the
app's own price tables. Some protocol adapters still stamp the source's own
valuation on coin rows — `zerionDefi.ts`, `naviPositions.ts`,
`jupiterPositions.ts` (limit orders) — and `valueHolding` uses it only when the
row's key has no price. **A $1-per-unit value is allowed only for the
stablecoins in `src/lib/stablecoinFallback.ts`** (Hyperliquid and Polymarket
dollar balances), as a last resort; any other coin without a price shows "—".

**A receipt token and its protocol position count once** (`receiptDedupe.ts`,
`dedupeReceipts`). A liquid staking or vault receipt (MaticX, eETH) that the
wallet holds is the same money as the Zerion position whose `pool_contract` is
that token. If the token is tradable (`asset_prices.volume_24h` ≥
`TRADABLE_MIN_VOLUME_USD`) the wallet token stays and the position is dropped;
if not, the position stays (where it's staked, how to withdraw) and the wallet
copy is dropped. Both lists come from the same sync (§4.4), so the check always
runs on fresh data from both sides. When Zerion's `pool_contract` doesn't name
the held token (Morpho vaults have none; Aave's is the lending pool, not the
aToken), the position is linked by reading the token on-chain through its
standard interface — ERC-4626, Aave aToken, Compound v3/v2
(`adapters/receiptTokens.ts` → `linkReceiptPositions`): same coin, same amount
within `RECEIPT_MATCH_TOLERANCE`, exactly one match — otherwise both stay. A new
receipt standard is added there, not special-cased per protocol.

**A receipt CoinGecko doesn't list is valued as its underlying coin** (owner
decision 2026-09-25): when a held EVM token has no price of its own but reads
as a standard receipt, the row stores the underlying amount, `coingecko_id` =
the underlying coin (its `price_key`) and a label like "hUSDB (as USDB)"
(`multicallEvm.ts` `priceScans`, `tokenDiscovery.ts` `classifyHeld`). Such a row
is never tradable for the dedupe above: the underlying's volume says nothing
about the receipt's own market, so its position stays when Zerion has one. A
debt token (Aave variable/stable debt — it answers `borrowAllowance`) is never
read as a receipt: a loan is not a holding (`receiptTokens.ts`).

**Resolution must work for assets the owner doesn't hold.** Exchange tickers
come from CoinGecko's per-exchange data, refreshed weekly
(`adapters/exchangeTickers.ts` `refreshExchangeAssetsIfStale`; rows with
`mapping_source` `manual` or `coinbase-registry` are kept); Kraken staking codes
resolve by Kraken's naming (`krakenStakedBase`); Cosmos `ibc/…` tokens are
traced over IBC to their home chain's registry entry (`adapters/cosmosMulti.ts`);
the token list refreshes weekly and when a Solana/Sui sync meets an unknown
token (`tokenRegistryRefresh.ts`). `/admin/pricing` (`pricingCoverage.ts`) lists
every unpriced holding across all users by cause; Settings → "Exchange coin
mappings" shows each user how their exchange tickers were matched.

**History.** Analytics keys price history by `price_key` (`priceHistory.ts`
`getPriceHistoryMap`): old `price_history` rows under the pre-price_key key,
rows under the key itself, and `asset_price_daily` (the daily snapshot's close,
`recordDailyCloses`). Backfill fetches CoinGecko coins only.

**Open item:** phase 3d drops the legacy stores (`prices`, `coin_market_data`,
`exchange_asset_registry`, `token_registry` price/stat columns) behind the gate
in BACKLOG.md. Nothing may read them.

### 4.3 A failed part of a sync keeps its previous rows

A sync replaces a wallet's auto rows atomically (the `sync_*_holdings` RPCs), so
a source that soft-fails must not return `[]` and erase its rows. Every soft
failure returns a `KeepScope` (`src/lib/carryForward.ts`: `chainScope`,
`protocolScope`) naming the rows it owns; they're re-saved from the last run and
the status says so. A new adapter or soft-failing source must declare one.
(DECISIONS: 2026-09-24)

**An error is never an empty result.** A source that fails throws (or
returns a failure); only an answer that really says "nothing here" is `[]`
(Etherscan's "No transactions found", Blockscout's 404 "Not found").
Transaction history follows the same rule: each chain tries its sources in
order (`transactionSources.ts` `txSourcesFor`: Alchemy, Etherscan,
Blockscout) and a chain none of them answers keeps its saved rows, named in
the status (`txSyncStatus`). (DECISIONS: 2026-09-26 Transaction history)

### 4.4 DeFi positions: native adapters first, Zerion fills the gaps

An EVM wallet's one Sync (`syncWalletHoldings`) fetches its balances, the native
protocol adapters (Hyperliquid, Lighter, INIT Capital, Axie, SuperVerse, Polymarket, …) and Zerion's
DeFi positions (`adapters/zerionDefi.ts`) in the same job — there is no separate
DeFi sync. **Zerion only covers protocols no native adapter owns:** each native
adapter exports the protocol names Zerion uses for it (`ZERION_PROTOCOL_NAMES`),
and `NATIVELY_COVERED_PROTOCOLS` skips them. **Building a native adapter for a
protocol means adding its Zerion names there in the same change**, so Zerion
never double-counts or overrides it. If Zerion fails, the last saved positions
stay and the sync status says so. Budget: one Zerion call per wallet sync
(free tier: 300/day, 1/second app-wide; its chain list is cached).
(DECISIONS: 2026-09-25 DeFi in the wallet sync)

The same rule holds on Solana: Jupiter's portfolio API
(`adapters/jupiterPositions.ts`) skips the products a dedicated adapter reads
(`SKIPPED_FETCHERS`: Jupiter Perps and Jupiter Prediction, read from their
dedicated APIs by `adapters/jupiterPerps.ts` and `adapters/jupiterPrediction.ts`).
An isolated-margin perps position is valued at what closing it returns
(collateral + PnL after fees), not its margin — see `jupiterPerps.ts`.
(DECISIONS: 2026-09-25 Jupiter Perps)

Every on-chain Solana adapter lists accounts through `adapters/solanaRpc.ts`
`getProgramAccounts`: Helius's paged `getProgramAccountsV2`, falling back to
the one-shot method. Never call the RPC for it directly.

### 4.5 Two independent kinds of staleness

Price freshness is per coin (`asset_prices.updated_at`, shown by `pricesAsOf.ts`
and the price cell tooltips). Sync freshness is per wallet
(`wallets.last_refresh_at` / `last_refresh_status`). Don't conflate them.

### 4.6 Every table lives in the `cryptoport` schema

The Supabase clients are pinned to it; a table anywhere else is invisible to the
app. Per-user tables get `user_id uuid references auth.users(id) on delete
cascade default auth.uid()` plus RLS `create policy "<table>: owner only" …
using (user_id = auth.uid())` (as `wallets`, `tags`, `linked_wallets`,
`portfolio_snapshots`). Shared tables get `grant all … to service_role` and, if
read by pages, a signed-in select policy. (DECISIONS: 2026-09-24 SQL in public)

### 4.7 Which tokens an EVM sync reads

`docs/sync/PLAN.md` is the design. Per chain (`multicallEvm.ts`
`fetchChainHoldings`):
- **Discovery:** each chain's `discovery` source (`evmChains.ts`,
  `adapters/tokenDiscovery.ts`) lists the contracts the address holds —
  Alchemy's token API (20 chains) or a Blockscout explorer's token list (Mode,
  Metis, Aurora, Merlin) replace the registry scan; Etherscan's transfer
  history (Taiko, Mantle, opBNB, Fraxtal, Sonic, Sei) only adds to it, because
  its free key allows 3 calls/second app-wide (`adapters/etherscanFetch.ts`
  paces every Etherscan call, discovery and Transactions alike; a wallet that
  would wait over 5 s skips it for that sync). All-or-nothing: an error, or
  more than the page cap, falls back to reading every listed token
  (`token_registry`), as chains with no source do. A new source is checked
  live per chain before it's added.
- **What is read:** discovered ∪ the wallet's tokens from the last sync (∪ the
  whole registry on fallback) — `tokenDiscovery.ts` `candidateTokens`. Balances
  always come from our own `balanceOf` multicall, never the indexer's number. A
  listed contract for the chain's native coin (CELO's ERC-20) is skipped, since
  the native balance already counts it.
- **What becomes of each held token** (`classifyHeld`): counted; a receipt
  valued as its underlying (§4.2); dust (≤ `TOKEN_USD_FLOOR`); or
  unrecognized (unlisted, or listed with no price). Unrecognized tokens go to
  `wallet_discovered_tokens`, never into totals and never written to
  `token_registry`; a token unseen for 2 syncs of its chain is removed. The
  wallet page lists them ("N unrecognized tokens not included", a collapsed
  section; `unrecognizedTokensQuery.ts`), with likely spam behind a toggle
  (`tokenSpam.ts`: a real web domain, a handle or a claim in the symbol, the
  name of a listed coin on the same chain, or look-alike letters). Symbols
  render as plain text, never links. `/admin/pricing` summarizes them across
  users.
- Each sync logs per-chain source, fallback, pages, time and counts to
  `sync_runs`. Check it before changing discovery.
- A new chain gets a `discovery` source when one is checked live (Alchemy
  first, then Blockscout, then Etherscan); otherwise it stays on the registry
  scan (Manta, PulseChain, Fantom, Cronos, Kava, Chiliz, Polygon zkEVM, DBK as
  of 2026-09-25 — no working free source).
(DECISIONS: 2026-09-25 Wallet balance discovery)

## 5. External APIs — sparing, deliberate, measured

- **Ask the owner before any CoinGecko call you initiate yourself** (scripts,
  diagnostics, verification, backfills — even a handful), and check
  month-to-date usage on the CoinGecko dashboard before a bulk run (the `/key`
  endpoint is Pro-only). Prefer another source (DefiLlama, Hyperliquid, the
  chain itself) when it answers the question. Plan limits and the app's own
  limiter are in `coingeckoFetch.ts` (`CALLS_PER_MINUTE`, header comment); the
  backup key (`COINGECKO_API_KEY_BACKUP`) is a safety net, not budget. Bulk
  scripts refuse to run past a call cap without `--confirm`
  (`scripts/screener-backfill.ts`). The app's normal usage and crons aren't
  gated, but every new call path you add must justify its cost.
  (DECISIONS: 2026-09-22)
- **Batch and dedupe by design:** one pricing pass per event, deduped across
  wallets and users (`ensureAssetPrices` reuses fresh prices); batched endpoints
  (`/coins/markets` by id, `per_page` = batch size); slow-changing data cached in
  the DB (below). Adding a per-holding or per-wallet call is a design smell.
- **Every external call goes through the shared plumbing:** `fetchWithRetry`
  (429/503 with backoff, honors `Retry-After`), `mapWithConcurrency` /
  `sequentialWithSpacing` (`adapters/http.ts`) — never an unbounded
  `Promise.all` over tickers/contracts; `coingeckoFetch.ts` (every CoinGecko
  call: rolling-window limiter, backup-key failover on quota errors);
  `jupiterFetch.ts` (process-wide pacer). Assume any new free API rate-limits
  bursts until proven otherwise.
- **Research before building an integration:** check for a standard, a
  maintained package, or a free API, and record its real rate limit and coverage
  in the commit or plan. Reuse over rebuild (EIP-6963 via `mipd`; a source's own
  24h-change field over computing deltas).
- **Verify live, don't trust docs or assumptions.** When data looks missing,
  reproduce against the real endpoint (under realistic load) before calling it a
  structural limitation. (DECISIONS: before 2026-09-22 "The API doesn't have
  this data")
- Every external `fetch()` passes `cache: "no-store"`. Live financial data is
  never cached without a staleness caption next to it.

### Caching

1. **Within a request:** wrap query functions several callers use in React's
   `cache()` (e.g. `getPriceMap`, `getAssetStatsMap`, `getActiveWalletsWithHoldings`).
2. **Slow-changing external data:** persist in the DB and refresh on a schedule
   or on demand — `token_registry`, `chain_icons`, `exchange_assets`,
   `coin_cache` logos. `ttlCache.ts` is an in-process cache for short-lived
   responses and carries `fetchedAtMs` so any shown value can be captioned.
3. **Expensive research artifacts** (an LLM explanation, a multi-API workup)
   are stored forever and recomputed only when a user asks: a compare-and-set
   claim plus the work inside `after()` (`claimTokenAnalysis`/`runTokenAnalysis`,
   `claimTrendExplanation`/`runTrendExplanation`), shown with
   `formatStaleness(computedAt)` and a Refresh button. Never a TTL that silently
   re-runs on a page load. (DECISIONS: before 2026-09-22 Research artifacts)
4. **Router Cache:** `next.config.ts` sets `experimental.staleTimes.dynamic` so a
   revisited page reuses its render. That is safe only because every real data
   change purges it: an action's own `revalidatePath`, or `JobPoller` →
   `notifyJobsComplete()` (`revalidatePath("/", "layout")`) when a background job
   finishes. If a Next upgrade narrows `revalidatePath`, re-check this.
   (DECISIONS: before 2026-09-22 Router Cache)

## 6. Background work and loading feedback

- **A Server Action doing more than a couple of seconds of work returns at once
  and does the work inside `after()`** (`next/server`). Next runs actions and
  navigations through one sequential queue per client, so an awaited slow
  action freezes every click app-wide. Pattern: `syncWalletHoldings`,
  `tryStartPriceRefresh` (`wallets/actions.ts`). `after()` shares the route's
  `maxDuration`, so pages whose actions start jobs export `maxDuration = 300`.
  A read the client calls often can be a route handler instead of a Server
  Action to stay out of that queue (`api/tv-symbol`). (DECISIONS: before
  2026-09-22 slow action)
- **Jobs claim their row with compare-and-set** (status not busy, or started
  before `JOB_STALE_MS`) and return a `JobStartResult`; status vocabulary and
  derivation live in `src/lib/jobStatus.ts` (`deriveJobStatus`). UI:
  `components/jobs/` — `useJob` + `JobButton` (locked for the real duration),
  `SlowJobHint`, one `JobPoller` loop over `/api/job-status`.
- **Completion reaches the browser through `JobPoller` → `notifyJobsComplete()`**,
  never through a `revalidatePath` inside `after()` (its response is already
  sent). One notify in flight at a time (it waits in the Server Action queue
  and re-renders the page), with `router.refresh()` if the action itself
  fails. A page's render time is part of every completion: keep data pages
  fast (no serial query loops). (DECISIONS: 2026-09-23)
- **Sync all** runs in the browser (`SyncQueue.tsx`): wallets sharing a
  rate-limited API form a lane (`syncLanes.ts`), lanes run in parallel, each lane
  runs up to `LANE_CONCURRENCY` at once; each wallet is its own request (its own
  time budget); per-wallet status is live and failures are summarized.
- **Every click is fast or says why it isn't.** Mutating forms use `SubmitButton`
  with a specific `pendingLabel` ("Refreshing prices…", not "Saving…"); slow work
  gets a caption saying why ("this pulls a live price for every holding").
- Every route that fetches on render is covered by a `loading.tsx`
  (`(app)/loading.tsx` for the group; add a route-specific one only for a
  tailored skeleton).
- **But `loading.tsx` only covers first entry into a route segment.** A same-route
  click that only changes a search param (tab, filter, re-search) shows nothing
  unless the param-dependent content sits in its own
  `<Suspense key={…params}>` — see `trend-finder/page.tsx`,
  `encyclopedia/page.tsx`, `signals/page.tsx`. (DECISIONS: before 2026-09-22
  searchParams)
- **Relative times** ("x ago") use a request-anchored clock —
  `requestNowSec()` (`requestClock.ts`) on the server, `useNowSec(serverNowSec)`
  (`components/useServerNow.ts`) on the client — never `Date.now()` at render
  (a cached render can be re-shown much later).

## 7. Code and UI conventions

- **Modular by default.** Small focused files over shared abstractions built
  ahead of need. Pure logic (no DB, no network) goes in its own `src/lib/*.ts`
  with a sibling `.test.ts`; the Supabase layer (`queries.ts`, `*Query.ts`) and
  components stay separate. Relative imports in files `node --test` loads need
  explicit `.ts` extensions.
- **`import "server-only"` in every module with a heavy or sensitive dependency**
  (viem, siwe, @noble/*, service-role DB). Tests keep working because `npm test`
  uses the package's `react-server` condition — never drop the guard to fix a
  test. A heavy module must not also export small pure helpers other code needs
  (`walletDisplay.ts` pure vs `walletAuth.ts` heavy). (DECISIONS: before
  2026-09-22 server-only; heavy module)
- **Duplication threshold:** before copying real logic (more than a 3–5 line
  presentational helper), grep for existing copies. Two copies is the limit; a
  bug fix that has to land in two copies means extract a shared version now. A
  tiny helper may be duplicated across a server-only boundary instead of
  importing the heavy module.
- **No band-aids.** Fix the category, not the instance: a gap found in the
  owner's data is a sample of a class of inputs. Fix the rule or source so other
  users' tokens, exchanges and DeFi positions resolve on their own, and make the
  gap visible (`/admin/pricing`). A hand-added data row is a labeled stopgap
  ("Set by hand (stopgap)" in Settings), never the fix. (DECISIONS: 2026-09-25
  category)
- **Reuse UI primitives** before building one-offs: `Panel`, `PageHeader`,
  `GuestBanner`, `SignInPrompt`, `AuthButtons`, `ui/table.ts` classes,
  `buttonClass`, `SubmitButton`. Small presentational duplication beats a shared
  component that needs prop-plumbing.
- **Guest state on a data page renders the real page shell:** one `GuestBanner`
  where `TotalValuePanel` would be, and every section's Panel with a muted "Log in
  and add a wallet to see your {noun} here." — no fake data. Public data (the
  Coin360 heatmap) renders for everyone. `SignInPrompt` is for pages with nothing
  to preview (`wallets/new`, `profile`).
- **Numbers** go through `src/lib/format.ts` (`formatUsd`, `formatPercent`,
  `formatQty`, `formatStaleness`…): `—` for missing; `text-positive` /
  `text-negative` / `text-warning` for gain, loss, warning; never a bare 0.
- **Tables are sortable by default:** `SortableHeader` / `SortIcon`
  (`components/ui/SortableHeader.tsx`) and `usePersistedState` keyed
  `cryptoport:<table>Sort`; a local `SortKey` union, a `sortValue(row, key)`
  switch, `toggleSort` flipping direction on repeat else `desc` (see
  `components/admin/AdminWalletsTable.tsx`). Columns with no scalar value skip it.
- **Mobile from the start:** secondary columns append `hideOnMobileClass` to the
  existing cell class; every table is wrapped in `overflow-x-auto`; the mobile
  nav drawer shares `navItems.tsx` with the sidebar.

## 8. Schema changes

- There is no migration tool. Hand the owner runnable SQL **as a plain fenced
  code block in the chat** (not through a tool call); they run it in Supabase's
  SQL editor. Write it to a scratch file and pass
  `node scripts/check-sql-schema.mts` first. Then update `db/schema.sql` to match.
- **Order: SQL handed over → owner confirms it ran → preflight passes → push.**
  Push deploys, and a cron writing to a column that doesn't exist yet fails.
  Code that needs unrun DDL waits on a hold branch (§9). (DECISIONS: 2026-09-22)
- **Plan anything with real blast radius** (new table, new external service,
  new cron, schema change, irreversible drop) and get the owner's OK on scope
  before writing code. For multi-step work, write a plan doc like
  `docs/pricing/PLAN.md`: goal, decisions, phases, and a verification gate per
  phase.
- **Design a core subsystem before building it** (pricing, balance discovery,
  sync, identity — anything other features will stand on). The design doc must
  answer: how 2–3 leading products solve the same problem (Zerion, DeBank,
  Rabby, CoinGecko…) and what their unit of truth is; which existing service
  already provides it (an indexer API before our own scanning); how it holds
  up at 10× the users, chains and tokens, and for a user whose assets look
  nothing like the owner's; what fails and how that shows. Fable reviews the
  doc before code. Building the simplest thing that works for the data at hand
  and growing it caused the pricing, DeFi-sync and chain-scan rewrites of
  2026-09-25. (DECISIONS: 2026-09-25 design before building)

## 9. Process and git

- **Push directly to `main`**; no PRs.
- **Phased work: one commit per phase** (a revertable unit). Before committing,
  show `git status` and the exact file list; don't bundle unrelated changes
  (local-only edits, scratch scripts, other backlog items). Then stop for the
  owner's sign-off before the next phase.
- **Held work goes on a local `hold/<name>` branch, never `main`** (waiting on
  DDL, on a cron check, …). Release with `git merge --ff-only hold/<name>`, then
  push. **A general "go ahead and push" never releases a named hold**: name the
  held commits, restate what each waits for, and ask. (DECISIONS: 2026-09-23)
- **Never run a command that discards uncommitted changes** (`reset --hard`,
  `checkout -- <path>`, `restore`, `clean`, `stash drop`, an overwriting branch
  switch) without first `git status`, `git stash push -u -m "<why>"`,
  `git stash list`. To move an unpushed commit off `main`:
  `git branch hold/<name>` + `git reset --soft HEAD~1` + stash.
  (DECISIONS: 2026-09-24 reset --hard)
- **`next.config.ts` carries a local-only `allowedDevOrigins` change: never commit
  it, never discard it.** Stage files by name, not with `git add -A`.
- **Exercise CRUD through the UI** (add wallets via the form), not seed scripts.
- **Verify against real data before calling anything done**, especially data
  correctness: live calls, real DB rows, before/after totals — not just passing
  type checks. A store's own read-back is not verification; spot-check against a
  different source. Report outcomes faithfully, including what wasn't verified.
- **Keep this file true.** When a rule's mechanism changes or is deleted, update
  or remove the rule in the same commit; record why in `docs/DECISIONS.md`.

@AGENTS.md

# CryptoPort — project guidance

## Purpose

A multi-tenant, multi-chain crypto portfolio tracker. The point is a single
place to see every wallet/holding you have, know what's moving, and get
enough signal to make a buy/sell decision — not a trading platform, not a
tax tool. Every feature should serve traceability (where is my money) and
trackability (what changed) first.

### The Dashboard is a lens, not a workshop

`/dashboard` presents existing data — it reads already-computed tables
(`AssetGroup`, `portfolio_snapshots`, etc.) and displays them. It should
never be where new computation/business logic gets built for the first
time. If a Dashboard request would require inventing new functionality
(a new metric that doesn't exist anywhere else, a new kind of aggregation,
a new data source), stop and say so explicitly, rather than building it
directly into the Dashboard page/components. Build that feature as its own
page/tab first (e.g. Analytics owns historical/derived calculations),
verify it stands on its own, and only then have the Dashboard consume it.
(Precedent: a 30-day value-history approximation was proposed for the
Dashboard directly and correctly redirected to become Analytics' job
instead — this section exists so that judgment call doesn't have to be
re-made from scratch next time.)

## Architecture

- **Modular by default, dependency only when it earns its keep.** Prefer
  many small, focused files over shared abstractions built ahead of need.
  Pure logic with no DB/network dependency (valuation math, formatting,
  dashboard math) belongs in its own `src/lib/*.ts` file so it's directly
  unit-testable with `node --test`, separate from the Supabase-fetching
  layer (`queries.ts`) and separate from components.
- **Don't reinvent the wheel.** Before building a non-trivial mechanism,
  check whether a standard, a well-known library, or a free API already
  solves it. (Precedent: EIP-6963 multi-wallet discovery via `mipd` instead
  of a hand-rolled provider listener; reusing Coinbase/CoinGecko's own 24h
  change fields instead of computing deltas from scratch.)
- **`node --test` needs explicit `.ts` extensions** on relative imports
  (`allowImportingTsExtensions` in tsconfig) — Node's native ESM resolver
  doesn't infer them the way bundlers do.
- **Every module that pulls in a heavy/sensitive dependency (viem, siwe,
  @noble/curves, ...) gets a real `import "server-only";`** — it's the only
  compile-time guard against that dependency leaking into a client bundle,
  and this app has already had one real leak that only got caught by
  review, not by tooling. `server-only` throws unconditionally when
  imported outside Next's own server bundle, which used to make this
  incompatible with `node --test` — fixed, not worked around: the package's
  own `package.json` declares a `"react-server"` export condition that
  resolves to a no-op instead of throwing, and package.json's `test` script
  runs `node --conditions=react-server --test` so files can carry the real
  guard and still be unit-tested. Never reach for "just don't mark it
  server-only" as the fix for a test-breakage — check whether the
  underlying package has (or could reasonably be given) the same
  conditional-export escape hatch first.
- **A bug fix landing in duplicated code is the trigger to unify it, not
  just patch every copy.** Several real duplications in this codebase were
  only found because a bug got independently re-fixed in more than one
  copy of the same logic (a wallet-lookup query, a DB upsert's dedupe
  step) — small duplication is fine (see above), but the moment the *same*
  logic needs the *same* fix applied more than once, that's the signal to
  extract a shared implementation instead of patching each copy separately.
- **Before copying a block of real logic (not a 3-5 line presentational
  helper), grep for existing copies first.** If two already exist, that's
  the threshold to extract a shared version rather than adding a third.
  When that constraint bites, duplicate the small helper locally rather than
  pulling in the dependency.
- **A heavy-dependency file (viem/siwe/@noble/curves/...) must not also
  hold the small, pure helpers other unrelated code needs.** `walletAuth.ts`
  used to export `pinnedWalletChain`/`walletDisplayName` (plain string
  logic, no heavy deps) alongside its actual signature-verification code —
  and because `(app)/layout.tsx` (wrapping every page in the app) and
  `queries.ts` (imported by every data-heavy read page) only needed those
  pure helpers, every single page load still pulled in the full viem/siwe/
  @noble/curves/@scure/base graph. Split into `walletDisplay.ts` (pure,
  imported by the hot read paths) and `walletAuth.ts` (heavy, imported only
  by the actual sign-in/link-wallet flow). When a file needs `server-only`
  for a genuinely heavy/sensitive reason, periodically check whether
  everything it exports still needs to be in that file.

## Data correctness — the rule that must never break

A missing value is **unknown**, never silently 0 and never a misleading
number. `valuation.ts`'s `Valuation` tagged union (`{kind:"unpriced",
reason}` vs `{kind:"priced", usd}`) exists specifically so "forgot to
handle missing data" is a type error, not a runtime surprise. Every later
feature follows the same rule: `blendedChange` excludes holdings with no
24h data from the average rather than treating them as flat, unpriced
holdings are counted and named (not dropped silently) from portfolio
totals, and the UI always shows `—` or an explicit warning rather than a
plausible-looking wrong number.

**This app has two separate valuation paths — know both before touching
pricing/valuation code:**
1. The ticker-keyed `prices` table (Coinbase primary, Jupiter fallback,
   refreshed by `refreshPrices()`) — global, shared across all holdings
   with that ticker.
2. Per-holding `usd_override` — computed and stamped directly onto a
   holding at sync time (e.g. every EVM token/native via CoinGecko in
   `multicallEvm.ts`, DeFi positions via their own protocol math). Per
   `valuation.ts`'s own doc comment, a holding with `usd_override` set
   **never** consults the ticker-keyed `prices` table — it's the source of
   truth for that holding until the next sync.

A lot of this session's debugging time went into re-discovering this split
after the fact. If a fix touches "why is a value/24h-change missing or
stale," check which of these two paths that holding actually uses before
proposing a fix.

**Known gap: plain Solana SPL token balances (`adapters/jupiter.ts`) are
the one auto-synced category still on path 1 (ticker-keyed), not path 2.**
EVM tokens/native and every DeFi-position adapter price themselves via a
per-holding `usd_override` specifically so a token can never be valued off
an unrelated asset that happens to share its ticker. Solana plain balances
don't — a copycat/spoofed-symbol mint that's still sellable (so it isn't
caught by `fetchJupiterHoldings`'s Jupiter-Shield `NOT_SELLABLE` filter,
added after a real incident where two spoofed tokens showed real-looking
USD values) gets priced off the real ticker's price in the shared `prices`
table, not its own mint's actual price. See `valuation.ts`'s "KNOWN GAP"
comment for the full explanation and why the real fix (stamping
`usd_override` from Jupiter's own per-mint price, matching the EVM
pattern) is a design change, not a patch.

**Staleness is also two independent things** — don't conflate them:
global price freshness (`price_refresh_state`, one singleton row) vs.
per-wallet sync freshness (`wallets.last_refresh_at`/`last_refresh_status`).

## API integration

- **Free and fast, in that order of research effort.** Before building any
  API integration, research the available free options and their actual
  rate limits/coverage — don't just start calling the first endpoint found.
- **Verify live, don't trust docs or assumptions.** Twice this session a
  plausible "the API just doesn't have this data" theory was wrong — the
  real cause (unbounded concurrent requests tripping a rate limiter) was
  only found by curling the real endpoint under real load. When data looks
  missing/wrong, reproduce it against the live system before concluding
  it's a structural limitation.
- **Respect free-tier rate limits by construction**, not by hoping: cap
  concurrency (see `mapWithConcurrency` in `adapters/http.ts`) and retry
  with backoff on 429/503, rather than an unbounded `Promise.all` fan-out
  over every ticker/contract at once. This has already bitten Coinbase's
  Exchange API and CoinGecko's anonymous tier — assume any new free API has
  the same failure mode until proven otherwise.
- Every external `fetch()` in this app deliberately passes
  `cache: "no-store"` — live financial data is never cached without an
  explicit staleness caption next to it. This is intentional, not an
  oversight; don't "optimize" it away.

## Caching — two different rules for two different kinds of data

1. **Within-request dedupe is always safe** and currently under-used: e.g.
   the Dashboard page calls `getPriceMap()` twice in one request because
   `getAssetsGroupedByTicker()` and `getWalletsWithTotals()` each fetch
   their own copy. React's `cache()` (native in Server Components) memoizes
   a query function for the lifetime of one request only — no cross-user,
   no cross-time staleness risk. Use it for query functions that multiple
   callers independently invoke in the same render.
2. **Cross-request caching only for slow-changing data**, and only in the
   DB itself as a persistent cache — `token_registry`/`chain_icons` are the
   existing pattern (fetched once, reused until an explicit "Refresh token
   list" action). Extend this pattern for new slow-changing external data.
   Never apply it to live prices/balances without the same staleness-
   caption discipline everywhere else in this app (`formatStaleness`).
3. **`next.config.ts` sets `experimental.staleTimes.dynamic = 1800`** — the
   client Router Cache's window for reusing a `force-dynamic` page's
   already-rendered result on a repeat visit (every page in `(app)/` is
   `force-dynamic`). This defaulted to 0s as of Next 15+ (a training-data
   trap — earlier versions defaulted to 30s), which meant every single
   navigation back to a page re-ran every query from scratch even a few
   seconds later; reported as "clicking Portfolio takes 7 seconds even
   though I was just there." First bumped to 60s under the assumption that
   `revalidatePath` (called by every mutating Server Action) reliably
   purges the client cache on any real change — investigated properly
   later and found *half* true: a plain, immediate action's own
   synchronous `revalidatePath` call does purge the cache (still every
   previously-visited page at once, not just the path passed in — Next's
   own docs still call this "temporary"), but a background job's
   completion-time `revalidatePath` call living inside `after()` could
   never reach the browser at all — Next attaches the client-cache-purge
   signal to the *response* of the Server Action that calls it, and
   `after()` runs strictly after that response has already been sent. A
   finished sync was silently failing to invalidate any tab that wasn't
   the one actively polling it; the 60s ceiling was a bound on how long
   that could last, not a fix for it. Fixed properly (see
   `components/jobs/JobPoller.tsx`/`jobActions.ts`: the poller detects a
   real busy→done transition and calls a live, reachable
   `notifyJobsComplete()` instead of relying on `after()`), which is what
   made raising this number to 1800 (30 min) actually safe — every real
   data change now purges the cache on its own regardless of this
   window's length, so it's no longer covering for a gap. If a future
   Next version narrows `revalidatePath` to only invalidate its own path,
   re-check this before trusting it again.
4. **A stored research artifact (an AI narrative explanation, an analysis)
   is reused forever until a user explicitly asks for a refresh — never
   TTL-expired into a silent recompute on a plain page load.** `token_
   analyses` and `trend_explanations` are the pattern: an on-demand claim
   (`claimTokenAnalysis`/`claimTrendExplanation`, CAS: update-if-stale-or-
   idle else insert) + the real slow call inside `after()`
   (`runTokenAnalysis`/`runTrendExplanation`), a `status`/`started_at`
   pair reusing `jobStatus.ts`'s own `IN_PROGRESS_STATUSES` vocabulary,
   always show the last result with `formatStaleness(computedAt)` next to
   a Refresh button — see `TokenAnalysisPanel.tsx`/
   `TrendExplanationRefresh.tsx`. `trend_explanations` originally used a
   24h TTL (`EXPLANATION_CACHE_TTL_MS`) that silently re-ran a live ~20-30s
   Perplexity call on whichever page load happened to land after the row
   turned stale — reported directly as "I thought we said everything
   should be stored... it showed up in Recent, which means I used it
   before" — a real, previously-searched token still paid the full cold-
   start wait because nothing about "already searched before" was part of
   the freshness check. A slow-changing figure with no real cost to
   recompute (a price, a balance) can still use rule 2's plain TTL cache;
   this rule is specifically for anything that costs real money/time per
   recompute (an LLM call, an extensive multi-API workup) — those get
   claim-and-store-forever, not claim-and-expire.

## Loading feedback — every click should either be fast or say why it isn't

- `SubmitButton` (`useFormStatus`-based: disables itself + shows a pending
  label while a Server Action runs) is the existing mechanism — use it for
  every mutating form, and give it a real, specific `pendingLabel`
  ("Refreshing prices…", not the generic default "Saving…") whenever the
  action isn't near-instant, especially when the delay is for a
  non-obvious reason (an external API call, an on-chain scan).
- Every route that fetches data on render should have a `loading.tsx` —
  `(app)/loading.tsx` covers every page under that group; add a
  route-specific one only if a page's fetch is slow enough to want a
  tailored skeleton instead of the shared one. **But `loading.tsx` only
  ever shows its fallback on a genuine first entry into that route
  segment** — verified directly from the installed Next.js source
  (`node_modules/next/dist/client/components/layout-router.js`): the
  Suspense boundary it creates is keyed *without* search params
  (`createRouterCacheKey(segment, /*withoutSearchParameters*/ true)`),
  and Next's own comment on that line says why: "search params do not
  cause state to be lost, so two segments with the same segment path but
  different search params should have the same state key." Once that
  boundary has resolved once, a same-route `<Link>` click that only
  changes a searchParam (a tab, a filter, a market-cap picker, a new
  search while results are already shown) suspends *inside an
  already-resolved boundary* during a transition — React's transition
  semantics then keep the old content on screen instead of falling back
  to the spinner, with **zero visible loading feedback**, until the new
  content is ready. This produced the same reported bug twice
  (`trend-finder`'s market-cap-floor picker, then `encyclopedia`'s tab
  pills) because the file-existence rule above sounds like it should
  cover this case and doesn't — don't rely on `loading.tsx` for it.
  **The fix for that case**: wrap the searchParams-dependent content in
  its own `<Suspense key={...}>` at the point where those params are
  read, keyed by whatever combination of params should trigger a fresh
  loading state (e.g. `` key={`${id}:${tab}:${mcapFloor}`} ``). A key
  change forces React to treat it as a brand-new boundary, which *does*
  show its fallback even mid-transition — same pattern as Next's own
  `?query=` search-page tutorial. See `trend-finder/page.tsx` and
  `encyclopedia/page.tsx` for the canonical example (`TrendResultsFallback`/
  `TabFallback`). Any new searchParams-driven tab/filter/re-search UI on an
  already-mounted page needs this, not just a sibling `loading.tsx`.
- If an action genuinely takes a while, say why in the UI (a caption, not
  just a spinner) — "this pulls a live price for every holding" is more
  useful than silence.
- **A Server Action that does more than a couple of seconds of real work
  must return almost immediately and do that work inside `after()`
  (from `next/server`), not by awaiting it directly.** Next dispatches
  Server Actions and client-side route navigations through one shared
  sequential queue per client — an awaited slow action doesn't just leave
  its own button pending, it freezes every other click (including
  sidebar/tab navigation) app-wide until it resolves. (Precedent:
  `syncWalletHoldings` in `wallets/actions.ts` does this correctly —
  flip a status flag, `revalidatePath`, return, then do the slow chain
  calls inside `after()`. `backfillHistoryAction` in `analytics/actions.ts`
  originally awaited `backfillPriceHistory()` directly, which froze
  navigation app-wide while it ran and was reported as a CLAUDE.md
  violation; fixed by moving to the same `after()` pattern.) `after()`
  still shares the route's `maxDuration` budget and can call
  `revalidatePath`. Known remaining offenders that have this same shape
  and haven't been fixed yet: `refreshPricesAction`,
  `refreshTokenRegistryAction`.

## UI conventions

- Reuse shared primitives (`Panel`, `PageHeader`, `SignInPrompt`,
  `GuestBanner`, `AuthButtons`, `ui/table.ts`'s class exports,
  `buttonClass`/`SubmitButton`) before building a new one-off. Small
  presentational duplication (e.g. a `ChangeCell`-style color helper
  redefined per file) is preferred over a shared component when the
  surrounding markup differs enough that sharing would need its own
  prop-plumbing — don't force abstraction just to avoid a five-line
  duplicate.
- **Guest state on a data page (Dashboard, Portfolio, Wallets, Assets,
  DeFi, Analytics) renders the real page shell** — same Panels, same
  layout — not a full-page `SignInPrompt` replacing everything. One
  `GuestBanner` sits where `TotalValuePanel` would (the page's only
  sign-up/log-in CTA), and every section below it still renders its own
  Panel/title with an honest muted "Log in and add a wallet to see your
  {noun} here." placeholder instead of real data — no button on these,
  just the one banner. **Never mock/fabricate data for the placeholder**
  (a fake total or fake table rows) — that's exactly the "plausible-
  looking wrong number" the Data Correctness rule above exists to
  prevent, guest or not. Public, non-personal data (the Dashboard's
  Coin360 heatmap) renders live for everyone regardless of auth — it was
  never gated on `user` to begin with. `SignInPrompt` (the original full-
  block version) is still correct for a page with genuinely nothing to
  preview — `wallets/new`'s form, `settings`' account-specific panels.
- Every number gets explicit formatting via `src/lib/format.ts`
  (`formatUsd`, `formatPercent`, `formatQty`, `formatStaleness`, …) — `—`
  for missing, colored (`text-positive`/`text-negative`/`text-warning`) for
  gain/loss/warning, never a bare unlabeled 0.
- Not too cluttered, and mobile-translatable from the start: secondary
  table columns get `hideOnMobileClass` (`hidden sm:table-cell`) appended
  — never replacing — the existing header/cell class; every data table is
  wrapped in `overflow-x-auto`; mobile nav is a separate drawer sharing
  `navItems.tsx` with the desktop sidebar rather than a divergent nav
  structure.
- **Every table gets sortable columns by default** — not a per-table
  request, the baseline for any new table with more than a couple of rows
  worth reordering. Use the shared `SortableHeader`/`SortIcon`
  (`ui/SortableHeader.tsx`) for the header cells and `usePersistedState`
  (keyed `cryptoport:<table>Sort`, e.g. `cryptoport:adminWalletsSort`) so
  the chosen sort survives a reload — see AssetsTable.tsx, WatchlistTable.tsx,
  HoldingsTable.tsx, and AdminWalletsTable.tsx for the exact shape (a local
  `SortKey` union, a `sortValue(row, key)` switch, `toggleSort` flipping
  direction on a repeat click else defaulting to `desc`). A column with no
  sensible sort value (an actions column, a rendered icon with no
  underlying scalar) just doesn't get a `SortableHeader` — the rest of the
  table still does.

## Database/schema conventions

- Every new per-user table needs `user_id uuid references auth.users(id)
  on delete cascade default auth.uid()` plus RLS:
  `create policy "<table>: owner only" ... using (user_id = auth.uid())`,
  matching `wallets`/`tags`/`linked_wallets`/`portfolio_snapshots`. Don't
  invent a different ownership pattern.
- No migrations folder or CLI in this project — `db/schema.sql` is
  checked-in documentation, kept in sync after the fact. The actual
  mechanism for a schema change: hand the user runnable SQL **directly in
  the chat response as a plain fenced code block**, never piped through a
  tool call (a tool call's output isn't visible/copyable to the user the
  same way) — they paste it into Supabase's SQL editor themselves.

## Process

- Push directly to `main` — no PR intermediate step.
- Verification gate: `npx tsc --noEmit`, `npm run lint`, `npm test`. For
  any push touching screener code, also `node scripts/check-screener-schema.mjs`
  — push deploys, so DDL the user hasn't run yet means the next cron writes to
  a column that doesn't exist. Hand over the SQL, wait for it to be run, pass
  the preflight, then push (twice on 2026-09-22 the push went first).
  `npm run build` will always fail locally at "Collecting page data" due to
  a permanent, unrelated local `.env.local` gap (`NEXT_PUBLIC_SUPABASE_ANON_KEY`
  empty) — known and non-blocking, not something to chase.
- `diag_*.mjs` untracked scratch scripts in the repo root are the
  established way to inspect/verify real DB state directly. Read-only ones
  can stay; delete anything destructive right after use. A diag script
  that needs real TS module resolution (importing a `server-only` `.ts`
  file directly, not just plain JS) needs `.ts` instead of `.mjs`, run via
  `NODE_OPTIONS="--conditions=react-server" npx --no-install tsx
  diag_whatever.ts` — but never name one ending in `_test.ts`/`-test.ts`/
  `.test.ts`: Node's test runner auto-discovers that exact suffix pattern
  and tries to run it as a test file, breaking `npm test` (real bug hit
  this session — `diag_full_sync_test.ts` got picked up and reported as a
  failing test until renamed/removed).
- Before declaring a fix "done" — especially a data-correctness bug —
  verify against real data/live calls, not just passing type checks. Two
  real catches this session (a Coinbase rate-limit bug, a Dashboard query
  against a table that didn't exist yet) only surfaced because of an
  explicit verify-before-reporting pass, not incidentally.
- For anything with real blast radius — a new DB table, new
  infrastructure (cron jobs, external services), a schema change — plan it
  and confirm scope before writing code. Small, reversible changes don't
  need that ceremony.

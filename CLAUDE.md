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
3. **`next.config.ts` sets `experimental.staleTimes.dynamic = 60`** — the
   client Router Cache's window for reusing a `force-dynamic` page's
   already-rendered result on a repeat visit (every page in `(app)/` is
   `force-dynamic`). This defaulted to 0s as of Next 15+ (a training-data
   trap — earlier versions defaulted to 30s), which meant every single
   navigation back to a page re-ran every query from scratch even a few
   seconds later; reported as "clicking Portfolio takes 7 seconds even
   though I was just there." Safe for this app's per-user financial data
   specifically because `revalidatePath` (called by every mutating Server
   Action already) currently invalidates the client cache for *every*
   previously-visited page, not just the path passed in — a real
   balance/holdings change is never masked by this window. If a future
   Next version narrows `revalidatePath` to only invalidate its own path
   (their own docs call the current all-pages behavior "temporary"),
   re-check this before trusting it again.

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
  tailored skeleton instead of the shared one.
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
  `ui/table.ts`'s class exports, `buttonClass`/`SubmitButton`) before
  building a new one-off. Small presentational duplication (e.g. a
  `ChangeCell`-style color helper redefined per file) is preferred over a
  shared component when the surrounding markup differs enough that sharing
  would need its own prop-plumbing — don't force abstraction just to avoid
  a five-line duplicate.
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
- Verification gate: `npx tsc --noEmit`, `npm run lint`, `npm test`.
  `npm run build` will always fail locally at "Collecting page data" due to
  a permanent, unrelated local `.env.local` gap (`NEXT_PUBLIC_SUPABASE_ANON_KEY`
  empty) — known and non-blocking, not something to chase.
- `diag_*.mjs` untracked scratch scripts in the repo root are the
  established way to inspect/verify real DB state directly. Read-only ones
  can stay; delete anything destructive right after use.
- Before declaring a fix "done" — especially a data-correctness bug —
  verify against real data/live calls, not just passing type checks. Two
  real catches this session (a Coinbase rate-limit bug, a Dashboard query
  against a table that didn't exist yet) only surfaced because of an
  explicit verify-before-reporting pass, not incidentally.
- For anything with real blast radius — a new DB table, new
  infrastructure (cron jobs, external services), a schema change — plan it
  and confirm scope before writing code. Small, reversible changes don't
  need that ceremony.

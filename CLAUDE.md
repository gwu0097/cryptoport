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
- **`server-only` throws unconditionally outside Next's bundler** — Next
  aliases it to a no-op only inside its own build. Any file that needs to
  stay testable standalone (e.g. `coinbase.ts`) must avoid importing
  anything that transitively imports `server-only` (e.g. `adapters/http.ts`).
  When that constraint bites, duplicate the small helper locally rather than
  pulling in the dependency.

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

## Loading feedback — every click should either be fast or say why it isn't

- `SubmitButton` (`useFormStatus`-based: disables itself + shows a pending
  label while a Server Action runs) is the existing mechanism — use it for
  every mutating form, and give it a real, specific `pendingLabel`
  ("Refreshing prices…", not the generic default "Saving…") whenever the
  action isn't near-instant, especially when the delay is for a
  non-obvious reason (an external API call, an on-chain scan).
- Every route that fetches data on render should have a `loading.tsx` —
  currently only `src/app/lookup/` has one; every other data page shows
  nothing while its query resolves. Add one whenever a page's data fetch
  isn't trivially fast.
- If an action genuinely takes a while, say why in the UI (a caption, not
  just a spinner) — "this pulls a live price for every holding" is more
  useful than silence.

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

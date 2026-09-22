# Phase 1 — Data layer and snapshot job

## What I built

Per your priority order (snapshot job first, then universe join, then backfill, then the read-only table). All inside cryptoport, namespaced per the approved placement plan: `src/lib/screener/*`, `src/app/(app)/screener/`, `src/app/api/cron/screener-snapshot/`, tables prefixed `screener_`.

- **`src/lib/screener/adapters/defillama.ts`** — `fetchProtocols()` (universe), `fetchFeesOverview(dataType)` (one call per metric covers every protocol), `fetchProtocolFeeHistory(slug, dataType)` (per-protocol history, backfill only), `fetchParentProtocols()` (see the real bug below).
- **`src/lib/screener/adapters/coingecko.ts`** — `fetchHistoricalMarketData` for backfill (price + market cap + volume; the shared adapter's existing history fetcher only ever captured price).
- **`src/lib/adapters/coingecko.ts`** extended, not duplicated — `MarketDataRow` gained `fdv`/`circulatingSupply`/`totalSupply`/`maxSupply`/`volume24h` (present in the same response every caller already gets, just unparsed until now), and `fetchMarketsByIds` now actually batches at 250 (it silently didn't before — harmless for its existing small-list callers, would have broken on this universe's size).
- **`src/lib/screener/snapshot.ts`** — the daily job: builds the universe, resolves each protocol to its real `gecko_id` and groups by it (see below), joins to CoinGecko, writes append-only snapshots with provenance, flags market-cap conflicts >5%, logs everything unmatched, self-checks for run-log gaps every invocation.
- **`/api/cron/screener-snapshot`** (`maxDuration=300`) + `vercel.json` entry, 07:00 UTC — distinct from the pre-existing unrelated `/api/cron/snapshot` (portfolio value history) found while planning this.
- **`src/lib/screener/backfill.ts`** + `scripts/screener-backfill.ts` — one-time historical backfill, idempotent, `is_backfilled=true`, rolling-window figures computed to match the live job's own column semantics (see below).
- **`src/lib/screener/pagination.ts`** — shared keyset-pagination helper, extracted after hitting the same PostgREST 1,000-row cap three separate times.
- **`(app)/screener`** — the read-only spot-check table (sortable, conflict/backfill flags), not linked from nav yet.

Nothing committed — per the brief, left for your review.

---

## What I verified

**Universe** (latest run): **831** resolved assets, **682** matched to CoinGecko, **38** flagged market-cap conflicts, **7,307** unmatched (logged with a specific reason each — no fee data, no resolvable gecko_id, or no CoinGecko row — never silently dropped).

**5 spot-checked examples**, cross-referenced against independent live captures taken earlier in this project (not just the pipeline's own output):

| Asset | Fees (30d) | Revenue (30d) | Notes |
|---|---|---|---|
| Aave | $35,987,099 | $5,086,396 | Exact match to an independent DefiLlama API capture from Phase 0 — same figures to the dollar. |
| Uniswap | — | $15,711,494 | Summed across `uniswap-v1/v2/v3/v4` — see the parent-resolution fix below. |
| Hyperliquid | — | $60,602,193 | Summed across `hyperliquid-spot-orderbook/hlp/perps`. |
| GMX | $4,717,003 | $1,344,526 | Summed across `gmx-v1-perps/v2-perps/solana`. |
| Lido | $49,043,486 | $3,046,717 | Holders revenue $775,187 — real, from a protocol with an actual fee-switch mechanism. |

**Conflict detection**: live, real disagreements — e.g. Reservoir (DefiLlama $457,709 vs. CoinGecko $749,909 mcap, 63.8% apart), Gearbox (19.7% apart) — flagged, not resolved silently, both values stored.

**No duplicate rows**: 682 snapshot rows in the latest run, 682 distinct `asset_id`s, verified directly (not assumed) after the grouping fix below.

---

## What surprised me — two real bugs, both caught before you'd have seen them, one fixed after you would have

### 1. Uniswap, Hyperliquid, and GMX were silently entirely absent from the universe

Not a rare gap — three of the highest-revenue protocols that exist. DefiLlama splits major protocols into versioned/product-line children (`uniswap-v2`, `uniswap-v3`, `uniswap-v4`, ...) that carry **no `gecko_id` of their own** — it lives only on a separate parent-aggregate resource (`/lite/protocols2`'s `parentProtocols` array) I wasn't fetching. Fixed: every protocol now resolves to its own `gecko_id` when it has one (Aave's `aave-v2` slug does), or its parent's when it doesn't (Uniswap's children do), and same-`gecko_id` protocols get grouped and their fees/revenue/TVL/holders-revenue **summed**, not left as separate silent duplicates. Live-verified the fix: Uniswap/Hyperliquid/GMX now appear with sensible aggregate numbers, and a same-run duplicate-`asset_id` check came back clean (0 of 682).

### 2. A pagination bug in my own cleanup script duplicated ~383K backfilled rows

Caught this one *after* it happened, not before — the backfill's own idempotency check (`select ... eq("is_backfilled", true)`) hit PostgREST's 1,000-row default `.select()` cap, so a second backfill run couldn't see 99.7% of the rows the first run had already written and re-inserted them. Root-caused (confirmed: 924,746 total rows = 383,557 + 541,189 exactly, before cleanup), fixed with real pagination everywhere a row count could exceed 1,000 (this gotcha independently bit three different ad-hoc scripts this session before getting a shared, tested fix — `pagination.ts`), and the ~382,557 actual duplicate rows deleted and verified gone (542,189 remain, matching the expected distinct count exactly; spot-checked Aave specifically — 1,000 rows, 1,000 distinct dates, 0 duplicates).

### Smaller, worth knowing

- DefiLlama's per-protocol history endpoint returns **daily** values, not rolling sums — caught before it shipped: I'd initially have written those straight into the live job's `_30d`-named columns (which mean rolling-30-day everywhere else), off by roughly 30x. Verified against Aave's real numbers (trailing-30-day sum of daily points ≈ the live rolling total30d, within 0.5%) and fixed with an actual rolling-window computation in the backfill.
- DefiLlama returns `400` (not `404`) for a `(protocol, dataType)` pair it doesn't track at all — e.g. Chainlink/Bitcoin have no `dailyHoldersRevenue` category. Live-verified the exact error body (`"Fees for X not found..."`) before treating it the same as 404 rather than a real failure — this had been silently killing the *other* successful fetches for the same asset via `Promise.all`, not just that one metric.
- A single-statement insert for a long-history asset hit a Postgres statement timeout — fixed by chunking inserts at 500 rows regardless of how deep an asset's history goes.

---

## Sign-off follow-ups

### 1. Survivorship test on the price source

Tested whether DefiLlama's coins API drops price history for dead/delisted tokens — this decides whether every backtest window beyond ~1yr would need a "survivor-only" label. Method: 7 real, confirmed dead-or-near-dead tokens, chosen by picking well-known collapsed/failed projects and verifying each still resolves to a real CoinGecko id (`/coins/{id}` returns 200, not 404) before testing — 2 candidates (`bitconnect`, `wonderland`, `anchor-protocol`) were dropped because CoinGecko itself no longer has any id for them at all, so there was nothing to test DefiLlama's *own* behavior against. For each surviving candidate, checked coverage at a date during the project's active life and at 30 days ago (recent):

| Token | id | During-life date | During-life covered | Recent (30d ago) covered |
|---|---|---|---|---|
| FTX Token | `ftx-token` | 2022-08-01 | yes, $30.30 | yes, $0.231 |
| Celsius (CEL) | `celsius-degree-token` | 2022-01-01 | yes, $4.23 | yes, $0.012 |
| Basis Cash | `basis-cash` | 2021-01-01 | yes, $1.11 | yes, $0.0015 |
| Terra Luna Classic | `terra-luna` | 2022-04-01 | yes, $102.39 | yes, $0.000056 |
| Mirror Protocol | `mirror-protocol` | 2022-04-01 | yes, $1.63 | yes, $0.0037 |
| IRON Titanium (TITAN) | `iron-titanium-token` | 2021-05-01 | no (HTTP 200, empty) | yes, $0.0000000026 |
| SafeMoon | `safemoon-2` | 2021-04-01 | no (HTTP 200, empty) | yes, $0.00000084 |

**Evidence for "no pattern found"**: 5/7 fully covered both during-life and recently, years after each project's collapse — DefiLlama is not dropping historical price data for dead tokens. The 2/7 gaps are at the *older* end (during-life date not covered, recent date covered) — the opposite direction survivorship-bias-via-dropping would produce (that would show covered-early, missing-recently). Most likely explanation: my chosen "during-life" date for those two predates when DefiLlama/CoinGecko actually started tracking their price, not evidence of anything being removed. Sample of 7 is suggestive, not proof — Phase 4's own per-window coverage reporting (item 2 below) is the real, ongoing safety net regardless of this finding.

### 2. Market-cap floor lowered to $10M — re-reported rated count

Config change applied (not yet in a committed config file — Phase 2 builds that; recording the decision here so it isn't lost): market cap floor **$100M → $10M**. Liquidity gate unchanged (24h volume < $2M → unrated). Revenue floor unchanged (annualized 30d revenue < $5M → unrated, using the real formula `rev_ann = revenue_30d × 365/30`, not just "nonzero fees").

Re-reported, all three gates applied together (latest run, 682-asset universe):

| Mcap floor | Passing all 3 gates (mcap + volume≥$2M + rev_ann≥$5M) |
|---|---|
| $100M (old) | 40 |
| $50M | 46 |
| **$10M (new)** | **52** |

Note this is a stricter, more correct number than the 81/85 reported at sign-off time — those used "nonzero fees" as the revenue condition, not the real $5M-annualized revenue floor. 52 is still a small rated population for sector percentiles (Phase 2's own min-4-per-sector rule) and Phase 4 statistical power — worth knowing now rather than discovering at Phase 2/3.

### 3. DefiLlama historical market cap — confirmed absent, not just untested

Live-tested `/mcaps/{coins}`, `/mcap/{coins}`, `/mcaps/historical/{ts}/{coins}` — all return real `404`s in the API's own "Route not found" format (not a generic gateway error). Cross-checked against DefiLlama's own official API docs (`api-docs.defillama.com`): the documented free coins/prices endpoint list is `/prices/current`, `/prices/historical`, `/batchHistorical`, `/chart`, `/percentage`, `/prices/first`, `/block` — **no historical market cap endpoint exists on the free tier**, confirmed by the docs directly, not inferred from a 404.

**Recorded for Phase 4, as required**: multi-year (beyond ~365d) backtests can test **momentum only** (price-derived: `mom_3w`, `mom_12w`, `beta_btc`). `ps_fd`, `pf_fd`, `buyback_yield`, `size` (log market cap), and any size-control regression are limited to CoinGecko's ~365-day window — Phase 4 must label which window each factor/test actually ran on, per your own instruction not to average across windows or treat them as interchangeable.

### 4. Per-field source provenance on merged rows — already built this way, confirmed

Backfilled rows can now genuinely mix sources within one row (DefiLlama price, CoinGecko mcap/volume) — `provenance` is a JSONB object keyed *per field*, not one row-level source, so this was already the design from Phase 0 (`{field_name: {source, endpoint, fetched_at}}`), not a new addition. Concrete example, a real merged row:

```json
{
  "price_usd": { "source": "defillama", "endpoint": "/chart/coingecko:{id}", "fetched_at": "..." },
  "market_cap_usd": { "source": "coingecko", "endpoint": "/coins/{id}/market_chart", "fetched_at": "..." },
  "volume_24h_usd": { "source": "coingecko", "endpoint": "/coins/{id}/market_chart", "fetched_at": "..." }
}
```
`price_usd`'s source is set per-day based on which source actually supplied that day's value (DefiLlama when it has data for that date, CoinGecko as fallback) — not a static per-row label. Queryable via Postgres JSONB operators (`provenance->'price_usd'->>'source'`) without needing new columns.

### 5. The 682 vs. ~345 study figure — recorded as unreconciled

Different inclusion rules (unknown exact study methodology) and a different date (the study's snapshot date vs. this run's 2026-09-22) — not chasing this further. Reference table for whoever revisits it: mcap≥$10M → 225 (nonzero-fees definition) / 52 (real 3-gate definition); mcap≥$50M → 124 / 46; mcap≥$100M → 85 / 40.

### 6. Backfill re-run with DefiLlama price + CoinGecko mcap merge

*[Pending — backfill re-run in progress with the new DefiLlama deep-price source (approved at sign-off) batched via `/chart` (multi-coin, chained past its 500-point/call cap) at the validated serial/1.5s throttle. Will report: rows written, date range covered, share of the 682 with price beyond 365 days, and how many rows have price but null mcap, once it completes.]*

---

Stopping here per the brief pending item 6. Nothing committed except the code itself, per your own "leave uncommitted for review" — you're reviewing and deploying Phase 1 yourself.

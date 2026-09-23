# Crypto fundamentals screener — current spec (v2 + amendments)

**Read this first if you're picking up Phase 2 or later.** This is the current, authoritative spec — the original v2 build prompt (reproduced in full below, unchanged) amended by every methodology/architecture decision made in chat during Phase 0/1. The amendments section below **supersedes** the matching part of the original text; don't build against the original section alone once it's been amended here. `PHASE_0.md` and `PHASE_1.md` (same folder) are the recon/build reports — this file is the spec itself.

---

## Amendments (supersede the matching original section below)

### Placement — DECIDED
Inside cryptoport, not csp-screener, not a new sibling app. `src/lib/screener/*` (lib code), `src/app/(app)/screener/` (UI route group), `src/app/api/cron/screener-snapshot/` (cron route), every table prefixed `screener_`. Hard rule: `src/lib/screener/*` is never imported by portfolio code (wallets/holdings/watchlist) — keeps this extractable into its own app later if it ever needs to be.

**Deviation from the original decision, flag this**: the original plan said "port the `earnings_history` provenance trigger" from csp-screener (a full trust-tier-precedence system: enum + `BEFORE UPDATE` trigger rejecting downgrades + rejection log). What actually got built is narrower — a partial unique index preventing exact duplicate backfilled rows for the same `(asset_id, date)`, not a trust-tier system. It solves the specific bug that motivated it (a real duplication incident, see `PHASE_1.md`) but does **not** implement trust-tier precedence or reject a write that downgrades confidence. If real multi-source trust-tier conflict resolution (not just duplicate prevention) is still wanted, that's unbuilt.

### Non-negotiable principles — one addition
Principle #6 ("store history point-in-time... store revisions as new rows") has one deliberate, narrow exception: a backfilled row's `price_usd` field can be corrected in place if the price-history *source* changes for a date that already has a row (see the DefiLlama price-source amendment below) — **this was considered and explicitly reverted** after it turned out to require thousands of sequential DB round-trips for marginal benefit (see `PHASE_1.md` item 6's own note). What's actually built: insert-only. A date that already has a row is never touched, even once a better source becomes available for it — DefiLlama's price only wins when constructing a genuinely new row (a date beyond CoinGecko's reach). If you want retroactive correction of already-backfilled dates, that needs a real (and efficient — batched, not per-row) implementation, not yet built.

### REQUIRED STEP — every new data store is spot-checked against a different source before it's trusted (promoted from a lesson, 2026-09-23)
**A file's or table's own read-back never counts as verification.** It goes through the same code or library that wrote the data, shares its assumptions, and can pass while the data is wrong. Before any new data store is used for anything (a backfill, an export, an archive, a derived panel, a cache), spot-check a sample of it against a **different source**: another endpoint, another tool, or an independent recomputation. Record the check and its result next to the store.

Three catches so far, all with a passing self-check at the time:
1. The archive's hyparquet read-back matched while every JSON column was double-encoded; DuckDB exposed it.
2. Grouped-protocol revenue was checked against DefiLlama's own parent page (`/summary/fees/{parent}`), not against our own summation.
3. Phase 4's deep price store passed its own fingerprint read-back while about half its dates were a day off; `/prices/historical` at 00:00 exposed it. (See "DefiLlama `/chart` dates are grid steps".)

### REQUIRED STEP — a date assigned to a fetched point is checked against the point's real timestamp (2026-09-23)
**The common shape of two real bugs: the data's label disagreed with its actual timestamp.**
1. The 2b beta bug: backfilled "daily" prices were really each backfill run's time-of-day, 21:31 not 00:00, so they were paired with BTC ~21.5 hours apart.
2. The `/chart` grid-date bug: points jittered across midnight were labeled with the wrong day.

**Rule:** any time we assign a date (or "same moment") to a fetched point, verify the point's **real returned timestamp**. Don't trust the requested grid position, the field name, or the API's own "daily" label. When two values in one row come from different sources, check that they're from the same moment before combining them (a ratio, a difference). If they aren't, the row's label is a convenience, not a fact.

### Standing rule — windowed calculations: flows vs. levels (decided 2026-09-22)
Two incidents, one root cause: a window whose two endpoints aren't the same kind of reading.
1. **Flows** — anything summed or counted over a day (fees, revenue, volume) — use **complete UTC days only; the current day is never an endpoint.** *(Incident: the backfill stored today's partial fees as a full day, and an insert-only design means it could never be corrected.)*
2. **Levels** — point readings (price, supply, dominance, open interest, funding) — **compare like with like: both endpoints are daily closes, or both are readings taken at the same moment of the day.** Mixing a daily close with an intraday value is the bug. *(Incident: the regime's stablecoin 30-day change compared an intraday supply level with a daily close 30 days earlier — 1.15% vs 0.646% on complete days; the undocumented `circulatingPrevMonth` figure also moved 0.94% → 1.107% between two runs 13 minutes apart, flipping BTC_LED's stablecoin clause.)*

**"Same moment" means the actual timestamp, not the label.** Found on the first 2b run: DefiLlama's `/chart` spaces its points from the requested start time, so a backfilled "daily" price is DefiLlama's price at *that backfill run's time of day* (HYPE 09-01 = its 21:31 price). Pairing it with BTC from a 00:00 grid is two daily points, but ~21.5 hours apart. It pulled the universe's median beta to 0.07; with the correct pairing it's 1.13. Pair backfilled rows with BTC on the same run's grid.

**Why the beta bug nearly shipped, and the rule that came out of it.** The original pairing rule ("a daily point pairs with a daily point") *sounded* correct, and the data was labelled daily. But DefiLlama spaces its points from the time of the request, so **the label was wrong**. Nothing failed: every row was well-formed, every test passed. The median beta of 0.07 was caught only because it's implausible on domain grounds. **Rule: derived metrics get plausibility ranges checked at compute time** (`config.plausibility`: rated-set medians for beta ~0.3–3, bounded momentum and revenue change; hard per-asset bounds for capture 0–1 and float ≤ 1.001). A run outside them logs a warning in `notes.derivations.metrics.plausibility_warnings`; the metrics are still written, but not silently. A silent wrong number is worse than a loud failure. The ranges are unvalidated starting values. On its first real run it flagged one rated asset (NEAR, float 1.000000006: CoinGecko's two supply fields sampled a moment apart), which set the 0.1% float slack.

This is deliberately *not* "never use the current day": two same-time-of-day readings (the regime's price/dominance/OI changes, momentum on 07:00 snapshots) have no partial-day problem, and forcing daily closes there would lag everything a day for nothing. **Phase 2b application:** the BTC reference paired with an asset reading must be the same kind — a backfilled daily point gets BTC's daily point for that date; a live 07:00 reading gets BTC's price at that same timestamp. This is a silent-bias bug if violated, so it gets an explicit test, not just this line.

### RLS — deviates from what was asked, for a real reason
The original ask (during Phase 0 decisions) was "read-all policy, no client write policies." What's built: **deny-by-default, no policies at all**, matching every other table in this Postgres instance. Reason, discovered while writing the SQL: this Postgres instance is **shared with csp-screener, whose anon key is public** (stated directly in `db/schema.sql`'s own header) — a real "public read" policy on screener tables would be readable by anyone holding that unrelated app's key, not just cryptoport's own users. Every read in this app already goes through `serviceDb()` server-side regardless, so deny-by-default costs nothing functionally. If you genuinely want client-side/public readability later, that's a conscious call to make then, not an oversight now.

### Data sources — confirmed, with real gaps
- **DefiLlama `/protocols`, `/overview/fees`, `/lite/protocols2` (parent protocols)** — free, no auth, no documented rate limit for reasonable use. See "Parent/child resolution" below — this is not optional, it's load-bearing.
- **DefiLlama coins/prices API (`coins.llama.fi`)** — separate host, separate rate-limit behavior from the above. `/chart/{coins}` (comma-separated, multi-coin) gives daily price history, hard-capped at **500 data points per call, counted as coins × span** — not 500 days per coin (corrected 2026-09-22 during the first validation backfill: 15 coins × 33 days → 200, 15 × 34 → 400 "Requested 510 data points exceeds the maximum of 500"; Phase 1 had read it as per-coin, which the never-completed batched path hid). Chain calls (advance `start` by `span*86400`) for depth beyond that. **No historical market cap or volume anywhere in this API** — confirmed both by live endpoint probing (`/mcaps`, `/mcap`, `/mcaps/historical` all real 404s) and DefiLlama's own official docs (`api-docs.defillama.com`) listing every free coins endpoint with none for historical mcap. This is a structural, permanent limitation, not a research gap to revisit.
- **Rate limiting on `coins.llama.fi` is real and was hit live**: a burst of ~700 near-concurrent requests triggered a hard lockout (`429 "Please reach out on Twitter or Discord for higher usage"`) that outlasted a script's own retry/backoff and took over an hour to clear. **Validated safe throttle: serial (concurrency 1), 1.5s delay between requests** — ran 200+ requests with zero rate-limiting. Use this rate for anything hitting this host; don't rediscover the lockout.
- **CoinGecko free/demo tier**: hard 365-day ceiling on historical `market_chart` (live-verified at the exact boundary: `days=365` works, `days=366` throws). This is why DefiLlama became the price-history source — see below.
- **Token unlocks**: DefiLlama's `/emissions` is confirmed Pro-only (live 402). No free forward-looking unlock-calendar API found anywhere. Decision already made (Phase 0): build `screener_manual_unlocks` for finalists only (token, date, amount, source URL, entered_at, entered_by) — hand-curated, not automated. No data = gate status `UNKNOWN`, never `pass`. **Not built yet** — Phase 1 didn't touch this table.

### Backtest price-history source — DECIDED, changes Phase 4's design
**DefiLlama is now the price-history source for backtesting; CoinGecko stays the live-snapshot (current-value) price source, unaffected.** Reason: CoinGecko's free tier caps historical price at 365 days; DefiLlama's `/chart` goes back to each asset's actual price-discovery origin (verified: Aave to 2020-12-04 — the same date its fee history starts — Bitcoin to 2014, correctly empty before 2010, not erroring).

**But DefiLlama's price API has no historical mcap or volume** (see above) — so the actual backfilled data is a **merge**, not a clean swap: `price_usd` prefers DefiLlama when available, falls back to CoinGecko's price for a date DefiLlama lacks; `market_cap_usd`/`volume_24h_usd` are **only ever from CoinGecko**, meaning they're null beyond CoinGecko's 365-day reach. **Every field's actual source is still recorded per field** — originally as a per-row `provenance` JSONB, now (storage fix, see "Storage, provenance, and retention" below) as the backfill run's manifest (price default: DefiLlama) plus a per-row `provenance_override` only on the dates whose price fell back to CoinGecko.

**Real, permanent consequence for Phase 4** (this is not something to re-derive later — it's structural): multi-year (beyond ~365d) backtests can test **momentum only** (`mom_3w`, `mom_12w`, `beta_btc` — price-derived). `ps_fd`, `pf_fd`, `buyback_yield`, `size` (log mcap), and any size-control regression are capped at CoinGecko's ~365-day window. **Phase 4 must report separately by window (1yr/2yr/3yr, with sample size and coverage rate each), label which factor was tested on which window, 1yr as primary (highest coverage, least biased), and report a divergence between windows rather than averaging across them if results flip.**

**Survivorship check, done**: tested 7 real dead/collapsed tokens (FTX Token, Celsius, Basis Cash, Terra Luna Classic, Mirror Protocol, IRON Titanium, SafeMoon) for DefiLlama price coverage both during their active life and recently (years post-collapse). 5/7 fully covered both periods; the 2/7 gaps were at the *older* end (not covered during-life, covered recently) — the opposite direction survivorship-via-dropping would produce. No evidence DefiLlama drops dead tokens from its price history. Full detail and exact numbers in `PHASE_1.md` item 1 — sample of 7 is suggestive, not proof; Phase 4's own per-window coverage reporting (above) is the ongoing safety net regardless.

**`/chart`'s 500-point-per-call cap, handled** (correction: the cap is coins × span per call, so `fetchChartPrices` now sizes each call's span as `floor(500 / coins)` — the text below predates that finding): DefiLlama's coins API hard-caps `/chart` at 500 daily points per call (live-verified: 500 succeeds, 1000 returns a real `400`). `fetchChartPrices` (`src/lib/screener/adapters/defillamaPrices.ts`) chains multiple calls to cover a longer window, each one's `start` advanced by the previous call's `span`, and **explicitly dedupes by UTC calendar date** across the chained calls (accumulates into a `date → price` map per asset during fetching, not a plain array) — DefiLlama's actual returned timestamps carry real jitter, not exact multiples of 86400s from the requested `start`, so a boundary date can legitimately appear in both of two adjacent chained calls; the later call wins. This was **not** originally explicit — an earlier version only got this right by accident, via a downstream caller's Map happening to overwrite duplicates — fixed to be deliberate at the source instead. Same function also owns its own throttle (1.5s before every individual HTTP call, including within a chain) after an earlier version that only throttled between logical batches let up to 4 chained calls fire back-to-back with no delay, which nearly re-triggered the original rate-limit lockout.

**One proposed, unbuilt index** for Phase 2/4's point-in-time query needs: backfilled rows carry `run_id = null` (they're not tied to a live snapshot run), so nothing currently serves an efficient "every asset's value as of date D" cross-sectional scan — the existing `(asset_id, observed_at desc)` index leads with asset_id, good for per-asset time series, not for a date-first scan across the whole universe. Proposal, not yet run:
```sql
create index screener_asset_snapshots_observed_idx on cryptoport.screener_asset_snapshots (((observed_at at time zone 'UTC')::date));
```

### Parent/child protocol resolution — load-bearing, not optional
DefiLlama splits major protocols into versioned/product-line children (`uniswap-v2`, `uniswap-v3`, `uniswap-v4`, `gmx-v1-perps`, `gmx-v2-perps`, `hyperliquid-spot-orderbook`, `hyperliquid-hlp`, `hyperliquid-perps`, etc.) that carry **no `gecko_id` of their own** — it lives only on a separate parent-aggregate resource (`/lite/protocols2`'s `parentProtocols` array, `id: "parent#uniswap"` etc.). Without resolving through this, **three of the highest-revenue protocols that exist (Uniswap, Hyperliquid, GMX) are silently entirely absent from the universe** — found live during Phase 1, not a hypothetical. A protocol resolves via its own `gecko_id` when it has one directly (some do, e.g. Aave's `aave-v2` slug); only falls back to its parent's `gecko_id` when its own is null. Same-`gecko_id` protocols get grouped and their fees/revenue/TVL/holders-revenue **summed** — verified against DefiLlama's own parent-page figures directly (querying `/summary/fees/{bare-name}` works for parent names too): Hyperliquid and GMX matched exactly, Uniswap within 0.85% (rolling-window timing, not a double-count — confirmed not a multiple).

### Universe reconciliation — real numbers, for whoever tunes the gates next
Latest verified run (2026-09-22): 831 resolved candidates, **682 matched to CoinGecko**. Of those 682:
- (a) token match + nonzero fees (30d): 566
- (b) token match, zero/no fee activity: 116
- (c) fee data present, no token match at all: 1,537 (1,388 no resolvable `gecko_id`, 149 resolved but no CoinGecko row — of which a 10-sample audit found 9/10 genuinely delisted with zero CoinGecko presence, 1/10 a stale `gecko_id` reference DefiLlama hasn't updated — see the "DefiLlama gecko_id staleness" backlog item in `BACKLOG.md`)
- 5,770 protocols had no fee data at all (excluded before resolution — a different bucket than (c))

A published 2026 study of the same DefiLlama universe found ~345 tokens with a traded market cap — **recorded as unreconciled**, not chased further (different inclusion rules, different snapshot date, exact study methodology unknown). Reference table if revisited: mcap≥$10M → 225 (nonzero-fees definition) / 52 (real 3-gate definition below); mcap≥$50M → 124 / 46; mcap≥$100M → 85 / 40.

### Kill filter — market cap floor lowered, DECIDED
**$100M → $10M.** Reason: 85 rated assets (at the old $100M floor, using the real 3-gate definition, not just "nonzero fees") is too few for Phase 2's own sector-percentile min-4-per-sector rule and Phase 4's statistical power. Liquidity gate unchanged (24h volume < $2M → unrated) — handles tradability on its own, doesn't need the mcap floor to do that job too. **Revenue floor lowered $5M → $1M annualized — decided 2026-09-22 (Phase 2a sign-off)**, same reason as the mcap floor: at $5M only 53 assets were rated. `rev_ann = revenue_30d × 365/30` — the real formula, not "any nonzero fees". (The user remembered lowering it earlier; no record of that existed in any doc, memory or the Phase 1 session log, so it's recorded here with today's date.)

**Current rated count (2026-09-22, $10M mcap / $2M volume / $1M revenue): 85.** Earlier figure, at the $5M revenue floor: **$10M floor → 52 rated** (was 40 at $100M, 46 at $50M — these are stricter/lower than earlier session numbers that used "nonzero fees" as a shortcut for the revenue condition instead of the actual $5M-annualized threshold).

Both floors now live in `src/lib/screener/config.ts` (Phase 2a).

### Quality & Risk — a TIER, not a score (full redesign from the original spec below)
The original spec's "Score A: Fundamental" (equal-weighted composite, own letter grade) **no longer exists in that form.** Renamed and redesigned in two rounds of amendment:

1. Earnings removed from v1 entirely (no DefiLlama data path exists for it — confirmed, see the data-sources amendment above) — not carried as a mostly-null field.
2. Valuation metrics (P/S, P/F, circ+FD) → display-only, weight 0 in any score until Phase 4 shows predictive value. Needs a config-level `active`/weight-0 field per factor (see "Candidate factor shape" below), not an implicit code-level omission.
3. **Renamed "Quality & Risk," and it is now a tier (Pass / Caution / High risk), never a score or letter grade.** Its job is filtering and risk-flagging, not predicting returns.

**Tier rules** (in `src/lib/screener/config.ts`), evaluated worst-tier-wins. **Revised 2026-09-22 (Phase 2a sign-off)** — three fixes, because the original rules made Pass empty by construction and let a documented buyback lower a tier:

| Tier | Triggers (any one fires) |
|---|---|
| **High risk** | measured `dilution_rate` > 25%/yr, OR real unlock data shows next-90d unlocks > 5% of circulating, OR revenue down > 40% vs. prior 90d |
| **Caution** | measured `dilution_rate` > 10%/yr |
| **Pass** | none of the above fire |

1. **Unlock status UNKNOWN is a display flag, never a tier trigger.** Only real unlock data triggers tiers. (Previously UNKNOWN → Caution, which put every asset without hand-entered unlocks — i.e. nearly all — in Caution, so LEADER/WATCH could never appear.)
2. **A rule with a null input does not fire.** Per-asset rule coverage (which rules were evaluable) is stored and shown next to the tier. Absence of data is not evidence of risk.
3. **Value-capture status is not a tier input at all**, including the old 60-day staleness rule. It stays a display field and the `buyback_yield` candidate factor. A documented buyback must never lower a tier.
4. **`dilution_rate` triggers tiers only when measured** from live circulating-supply snapshots. `dilution_rate_implied` (backfilled market cap ÷ price) is stored for display only — an inferred input must not drive a risk tier.

Every triggered rule is stored (not just the resulting tier), same "show the inputs, never a black box" discipline as the regime label. The kill-filter table's unlock-overhang gate (>10%/90d → `UNRATED`) is separate and likewise needs real data: no data = `not_evaluable`, which neither passes nor fails. Both layers apply — "can we evaluate this at all" vs. "how much to trust it".

`dilution_rate` has a **second, separate job**: as a weight-0 candidate alpha factor in the *momentum* ranking (Score B), pending Phase 4 proof, same as P/S, P/F, and `buyback_yield` (below). One job each — driving a tier threshold here, earning weight there — not the same thing twice.

### Score B (momentum) is now the primary ranking signal
Real shift from the original spec (which treated Score A "cheap?" and Score B "good timing?" as co-equal axes). Score B (3w/12w momentum vs. BTC) is primary; Quality & Risk filters/flags rather than co-ranks.

### New candidate factor: `buyback_yield`
`buyback_yield` = annualized `holders_revenue` / market cap. Computed and displayed, weight 0 until Phase 4 tests it. Shares the same open dependency as `capture`: `dailyHoldersRevenue`'s 0-vs-not-tracked ambiguity (DefiLlama returns a literal `0` for protocols with no holder-payout mechanism at all — indistinguishable from "not tracked" — confirmed live on Aave) means both `capture` and `buyback_yield` should be `null`, not `0`, for any protocol not in `KNOWN_HOLDER_VALUE_MECHANISMS` (below).

### Setup tags — replaced, full 3×3 grid
`POSSIBLY MISPRICED` removed everywhere — the model no longer claims to detect mispricing, only momentum + risk tier. New tags, "momentum third" = Score B percentile tercile among rated (non-`UNRATED`) assets:

| Quality & Risk tier \ Momentum tercile | Top third | Middle third | Bottom third |
|---|---|---|---|
| **Pass** | LEADER | NEUTRAL | WATCH |
| **Caution** | SPECULATIVE | NEUTRAL | NEUTRAL |
| **High risk** | SPECULATIVE | NEUTRAL | AVOID |

**Letter grade** = Score B percentile (`timing_grade_raw`), unchanged percentile→letter mechanism from the original spec (exact breakpoints still Phase 3's job to set). **High risk caps the displayed grade at C**, regardless of the raw percentile. **Caution does not cap anything** — it only participates in the tag grid above. Store both the raw and the final capped grade (`timing_grade_raw` vs `timing_grade`) so a capped C is auditable back to "this was really a B" — a deliberate addition beyond what was literally asked, in the spirit of the spec's own "every number traceable" principle.

### `KNOWN_HOLDER_VALUE_MECHANISMS` — filled 2026-09-22, every entry source-verified
Lives in `config.ts` as `holderValueMechanisms`, keyed by gecko_id: `hyperliquid`, `pump-fun`, `sky` (active); `aave` (paused); `ethena`, `lido-dao` (conditional). Shape: `{status, mechanism, sourceUrls: string[], as_of}`. It has `sourceUrls` (plural) because HYPE and ENA each need two sources. **`as_of` = the latest date a cited source shows the status**, not the date it was entered — AAVE is `2026-06-25` (the last evidence of the pause; nothing confirms September), LDO `2026-06-30` (the H1 report carries no publication date). Two of the originally supplied citations didn't support their numbers (HYPE's ~99%, ENA's $7.5B threshold) and were replaced with sources that do. Value capture is display-only (see the tier rules above); an asset absent from the config gets `capture`/`buyback_yield` = null, never 0.

### Candidate factor shape — decided, enforced
```ts
export interface CandidateFactor {
  factor: string;                // "ps" | "pf" | "buyback_yield" | "dilution_rate"
  weight: number;                // 0 until "active"
  status: "candidate" | "active" | "rejected";
  evidence_ref: string | null;   // required non-null to move to "active" — enforce this, not just document it
  changed_at: string;
  note: string;
}
```
`screener_scoring_config_versions` (not built yet — Phase 2 concern) gains a `config_hash` (SHA-256 of canonical-serialized weights+thresholds, computed once at version-creation). "Stamp every scoring run with a hash of the full config" is satisfied via `screener_asset_scores.config_version_id`'s FK to that versioned table, not by duplicating the hash onto every row. One real open design question surfaced, not resolved: `screener_runs` (the snapshot-pipeline execution log) and a future scoring pass aren't obviously the same "run" concept once Phase 2/3 exist — likely needs its own `screener_scoring_runs` table, not decided since it isn't needed yet.

### Schema — what's actually built vs. proposed
Built (Phase 1): `screener_assets`, `screener_runs`, `screener_asset_snapshots` (append-only, `is_backfilled` flag, per-field `provenance` JSONB, partial unique index on `(asset_id, (observed_at at time zone 'UTC')::date) where is_backfilled`), `screener_field_conflicts` (own unique index on `(asset_id, run_id, field_name)`), `screener_unmatched_log`. RLS: enabled, no policies (deny-by-default) on all five.

Added in the storage fix: `screener_unmatched` (replaces `screener_unmatched_log`), `screener_runs.kind`/`provenance`, snapshot `contributing_slugs`/`provenance_override`, and a plain `(observed_at)` index in place of the proposed UTC-date expression index — see "Storage, provenance, and retention" above and `db/schema.sql`.

Not built (Phase 2+ concern, proposed shape only in `PHASE_0.md` §7): `screener_manual_unlocks`, `screener_regime_snapshots`, `screener_scoring_config_versions`, `screener_asset_metrics`, `screener_asset_scores` (needs updating to match the tier-not-score redesign above — the originally-proposed columns `quality_risk_score`/`quality_risk_grade` are wrong now, need `quality_risk_tier`/`quality_risk_reasons` instead), `screener_asset_research`, `screener_invalidation_alerts`, `screener_backtest_runs`.

### Cron — approved, built, deployed, scheduled firing confirmed 2026-09-23
**Confirmed:** the first scheduled run (`8798244f`) started 2026-09-23 07:58:43 UTC with `trigger: "vercel-cron"`, header `0 7 * * *`. The project's team is on **Vercel Hobby** (checked via the Vercel API: `billing.plan = "hobby"`), where a cron fires *anywhere within* its scheduled hour, so 07:58 is on time. The header alone doesn't prove automatic firing (a `vercel crons run` carries it too); the timestamp landing inside 07:xx does. Vercel delivery is best-effort: a run can be silently skipped (the gap detector records it the next day) or occasionally delivered twice (see "Duplicate invocations" below).

**Duplicate invocations (checked 2026-09-23).** A second delivery on the same day makes a second `screener_runs` row with its own 682 live rows; the live unique index is per run, so it doesn't block that, and it isn't meant to. Downstream it's harmless: history reads take one reading per asset per UTC day (the latest), funding history keeps one value per UTC day, the unmatched log diffs against the open set (a sequential second run is a no-op), config versions tolerate a concurrent insert (23505 handled), and metrics/regime/scores are per run. Two edges: (1) if two deliveries **overlap in time** on a day when new unmatched items appear, the second one's insert hits the open-interval unique index and that run is marked `error` *after* its snapshot rows are written (no data lost or corrupted, one spurious error run, its derivations skipped); (2) anything reading "one run per day" (Phase 4's backtest, 3b's "latest run") must pick one run per UTC day explicitly, not assume there's only one.

Original text:
Vercel Cron, `/api/cron/screener-snapshot` (distinct from the pre-existing unrelated `/api/cron/snapshot`), 07:00 UTC, `maxDuration=300`. Every invocation's `screener_runs.notes` records `{trigger: "vercel-cron"|"unknown", cron_schedule_header}` read from Vercel's own `x-vercel-cron-schedule` header — durable evidence that outlives Vercel's log retention, including on a run that errors before finishing. Missing-day gap detector built into the job itself (checks the last 14 days of run history on every invocation, records gaps into that run's own `notes`). **Deployed and confirmed live** (`vercel crons ls` against production, not just local `vercel.json`) — registered, `0 7 * * *`. First real scheduled firing: 2026-09-23 07:00 UTC; check `screener_runs.notes.trigger = "vercel-cron"` afterward to close out the empirical proof. To pause (e.g. if the Supabase storage overage in `BACKLOG.md` turns out to trace back here): Vercel dashboard → project → Settings → Cron Jobs, instant, no redeploy.

**Known constraint**: the daily job writes ~682 rows/run — negligible on its own, but Supabase storage is currently at 355% over the free-tier quota (see `BACKLOG.md`, high priority) — likely caused by this session's backfill activity, not the daily job. The daily job was deliberately kept running through that discovery (unlike backfill, which is fully paused) because each missed day is point-in-time history that can never be recovered — see `BACKLOG.md` for the reasoning and diagnosis plan.

### Storage, provenance, and retention — DECIDED (2026-09-22, storage-overage fix)
- **Provenance is per run, not per row.** `screener_runs.provenance` holds one manifest (field → {source, endpoint}, plus `fetched_at`); `screener_asset_snapshots.provenance_override` is null unless that row's field came from elsewhere (a backfilled price that fell back to CoinGecko); `contributing_slugs text[]` stored once per row fills `{slug}` endpoint templates. `resolveFieldProvenance` (`src/lib/screener/provenance.ts`) reconstructs full per-field provenance — principle #3 still holds, it's resolved instead of repeated. The old per-row JSONB was 92%/70% of backfilled/live rows on disk and caused a 1.7 GB / 0.5 GB quota overage.
- **Backfill** writes a `kind = 'backfill'` run row, sums every contributing slug through the same function as the live job (`aggregate.ts` — the old single-slug path produced wrong fees/revenue for every grouped asset), and writes at most 365 days into Supabase. Deeper DefiLlama price history belongs in local Parquet, not this table (not built yet).
- **Backfill rule: DefiLlama `/chart`'s 500-point cap is per call, counted as coins × span.** Live-verified boundary 2026-09-22: 15 coins × span 33 = 495 → 200; 15 × 34 = 510 → 400 `"Requested 510 data points exceeds the maximum of 500"` (and 20 × 366 → `"Requested 7320..."`). Phase 1 read it as 500 days per coin; the batched path that would have exposed this never completed a run. `fetchChartPrices` sizes every call's span as `floor(500 / coins)` and chains — so batching coins barely reduces total calls (points ÷ 500 either way); it exists only to keep call count flat, not to beat the cap.
- **Backfill rule: the window ends yesterday (UTC); today is never backfilled.** Every source's current day is incomplete — on the first validation run today's rows had an intraday price, null mcap for 19/20 assets and null fees for 9/20. The backfill is insert-only and skips any date that already has a row, so a partial day written once can never be corrected by a later run. (The 20 partial rows from that first run were archived and deleted — the archive's first `--delete` test.)
- **Backfill rule: budget external API calls before running, never after.** The first full run exhausted the CoinGecko Demo key's 10,000 calls/month cap (error 10006) and took down every CoinGecko-backed feature in the app — the projection had counted only the backfill's own calls, not month-to-date usage. Now: `scripts/screener-backfill.ts` prints a plan (assets to fetch = CoinGecko calls) and refuses more than 50 calls without `--confirm`; finished assets are skipped before any external call (an asset's rows are one all-or-nothing insert); and every CoinGecko call fails over to a backup Demo key on the monthly-cap rejection (`coingeckoFetch.ts`). Check the CoinGecko developer dashboard's month-to-date usage before confirming a large run.
- **Measured sizes (validation backfill, 2026-09-22)**: new-format row datum 242 B backfilled / 275 B live (was 1,611 / 729); all-in marginal cost incl. indexes ≤ 360 B/row (upper bound — index pages grow in chunks), ~118 B of it index overhead.
- **Unmatched items** are a change-only interval log (`screener_unmatched`), not 7.3K rows per run.
- **Retention**: monthly, rows older than 400 days → local Parquet (verified by count + content hash) → deleted from Supabase. `screener_runs` rows are never deleted. Script: `scripts/screener-archive.ts`; schedule: `scripts/launchd/`.
  - **Threshold: 400 days, decided.** Steady state ≈ 400 × 682 rows × ~375–510 B ≈ 102–139 MB of snapshots, ~190–225 MB whole database (40–45% of the 0.5 GB tier). If that tightens, the lever is dropping to ~200 days: the design's longest lookback is 180 days (revenue 90d vs prior 90d) plus buffer; everything past that is margin.
- **`screener_asset_snapshots.run_id` is NOT NULL but its FK is still `ON DELETE SET NULL`** (from Phase 1; the NOT NULL was added later as a tripwire against the old run-less backfill). Deleting any `screener_runs` row that snapshots reference therefore **errors** (the SET NULL action violates NOT NULL). Deliberate, left as is: runs are never deleted — the archive keeps them.

### Phase 2a — regime, sector buckets, snapshot indexes (decided 2026-09-22)
- **Regime thresholds are unvalidated starting guesses** (`config.regime.validated: false`). Flat band ±0.5pt dominance / ±1% stablecoins; ROTATION needs dominance −1.5pt over 4w; FROTH = funding ≥ 90th percentile of stored history OR OI 4w change − price 4w change > 20pt; precedence FROTH > RISK_OFF > ROTATION > BTC_LED > NEUTRAL. Dominance and OI have no free history, so their 4-week changes build from our own stored rows (28-day warm-up); until then the rules needing them are not evaluable. Revisit after 28 days. At ~58-60% dominance BTC_LED will fire nearly always — **if the label never varies in the first month, revise the thresholds; don't treat a constant label as informative.**
- **Stablecoin 30-day change: one source, decided 2026-09-22.** On the first run, the two DefiLlama endpoints disagreed across BTC_LED's ±1% "flat" band (snapshot `circulatingPrevMonth`: 0.94%; history chart incl. today's in-progress point: 1.15%). That meant an implementation detail was deciding the label, and widening the band would only move the edge. **Chosen: `/stablecoincharts/all` (USD-pegged total), last *complete* day vs the point exactly 30 days earlier by date.** Why:
  - "A month ago" is explicit date arithmetic in our code, not an undocumented API field.
  - Both ends are daily closes: today's point is excluded, because it carries extra fields and an intraday value.
  - It's the same calculation as the planned switch to our own stored history, so there's no jump in the series.

  On the day of the decision it read +0.646% (08-22 → 09-21). The snapshot endpoint's figure is stored alongside (`stablecoin_supply_30d_change_pct_prevmonth`) for comparison only. **Once 30 days of our own stored supply exist (~2026-10-22), the 30-day change switches to stored history** (BACKLOG).
- **Sector buckets** (DefiLlama category → bucket) are in `config.sectorBuckets`. Prediction Market sits in perps_dex only because the rated universe is thin — revisit past ~100 rated assets. A grouped asset's sector is now its **highest-revenue child's** category (previously the first child's, which filed Hyperliquid and PUMP under "Dexs").
- **Snapshot indexes reviewed at 245K rows — keep all five**: backfilled-only unique 15 MB (1,090 scans; insert-time duplicate checks), asset_observed 15 MB (5,963), pkey 9.2 MB (7,080), run_idx 2.7 MB (98), observed 1.8 MB (150). A live-path duplicate guard was added: unique `(run_id, asset_id) where not is_backfilled`.
- **Metrics retention**: `screener_asset_metrics` kept 90 days, then archived to Parquet and deleted (recomputable from snapshots + the versioned config).

### Phase 3 — scoring decisions (2026-09-23; full table in `PHASE_3_PLAN.md`)
- Scores live in `screener_asset_scores`, keyed by the snapshot run (`run_id`) + `config_version_id`. **No separate scoring-runs table** (closes the open question in "Candidate factor shape" above) unless scoring ever runs on its own cadence.
- **Score B** = mean of `mom_3w`'s and `mom_12w`'s percentile ranks (mid-rank) across the rated **full-history** assets (both legs present); both missing → null. Grade cutoffs 80/60/40/20, tercile edges 2/3 and 1/3, all `validated: false`.
- **One leg missing = "insufficient history" (revised 2026-09-23; the one-leg fallback was withdrawn).** Averaging two percentile ranks compresses variance, so a one-leg score keeps the full 0–1 range and lands at the extremes by construction (the dry run put STONK at #1 on a single +1118% leg — an artifact). Such an asset gets `timing_score` and a `timing_percentile` placed against the full-history distribution, but **no grade, tercile or setup tag**, and is shown separately. It isn't part of the ranking population, so it can't move anyone else's rank. No shrinkage constant. The count per run is in `notes.derivations.scores.counts.insufficient_history`.
- **Regime modifier**: `adjusted = base − betaPenalty × (beta percentile − 0.5)` per label, **every penalty 0**; non-zero requires an `evidence_ref` (enforced).
- **Confidence** = momentum legs present + no price/mcap source conflict; tier-rule coverage is a separate figure, not part of it. (A one-leg asset is ungraded regardless; its confidence is still stored.)
- **Size check**: >60% of the top tercile in one market-cap bucket (<$100M / $100M–$1B / >$1B) flags the run.
- **Scope rule (decided 2026-09-23; decide the next case by this, not ad hoc).** *Does the revenue DefiLlama attributes to the token represent the token's own core business, or is it an app/bridge filed under the chain?* An app or bridge filed under a chain, valued against the whole chain's market cap, is **out of scope**. A chain whose protocol *is* the business, or an L2's own sequencer revenue, is **in scope**. Whether holders capture that revenue is a value-capture question, not a scope one, and ranking is on momentum anyway.
  - **Out** (`config.scopeOverrides`, gecko_id → out_of_scope + reason + date): NEAR (Intents bridge + Perps), SOL, SUI, AVAX, APT (canonical-bridge revenue).
  - **In**: HYPE, DRV, RUNE, DYDX (the protocol is the business), ARB, OP (sequencer revenue is the chain's own business).
  - The category gate can't see these cases, because DefiLlama files the app under a parent whose gecko_id is the L1. **Nothing is excluded automatically.** `scripts/diag/screener-l1l2-rated.mjs` lists rated assets CoinGecko tags L1/L2 for review; each run of it goes in `PHASE_3.md` (or the current phase report).

### One run per UTC day — DECIDED 2026-09-23 (3b, and Phase 4 must use the same rule)
A UTC day can have more than one live run: Vercel sometimes delivers a cron twice, and manual runs add more (2026-09-22 had five). **The day's run is the latest live run of that UTC day (by `started_at`) whose `status = 'ok'`.** A later run carries fresher data. Runs with status `running`, `error` or `partial`, and backfill runs, are never chosen. Implemented once, as the pure `pickRunPerUtcDay` / `latestDailyRun` in `src/lib/screener/runSelection.ts` (tested). 3b's page uses it, and **Phase 4's backtest must import the same function**, not re-derive the rule in a query. Consequence, stated honestly: the chosen run's derived rows (metrics/regime/scores) are written after the run turns `ok`. For about a minute after a run finishes, and permanently if a derivation step failed, the chosen run can have no scores. The page then says so, with the recorded `scores_error`. It does **not** silently fall back to an earlier run: an earlier run of the same day would be a different snapshot, presented as if it were today's.

### Degraded runs: CoinGecko unavailable → write a partial day, never lose one (DECIDED 2026-09-23)
A day of point-in-time history that isn't captured can never be recovered, which is why the snapshot job shipped first. Before this fix, a CoinGecko failure (both Demo keys capped, or an outage) threw before any row was written. The run was `error` with **zero rows**, and the day was lost. Now:
- **Trigger:** `fetchMarketsByIds` throws after the shared retries and key failover. The **whole run** degrades; nothing is recovered batch by batch. A uniformly thin day is better than one where some assets have market cap by luck of the batch.
- **What's written:** a row for every **already-known** asset (in `screener_assets`), using its stored name and ticker. `price_usd` comes from DefiLlama `coins.llama.fi /prices/current/coingecko:{id}`, in batches of 100: live-checked, 200 ids (4.2 KB URL) works, 250 returns 400, 500+ returns 414. `bitcoin` is in the same batch, so the BTC reference is same-moment. Fees, revenue, holders' revenue and TVL are unchanged, since they come from DefiLlama anyway. **Market cap, FDV, supply and volume are null.** A resolved gecko_id with no `screener_assets` row is skipped that day (there's no name or ticker without CoinGecko) and counted in `groups_skipped_not_in_assets`. That's mostly the ~149 ids CoinGecko never had data for, plus any genuinely new asset, which waits for the next complete run.
- **Nulls flow as designed:** `core_data` fails without market cap, so **nothing is rated on a degraded day**. Measured dilution and market-cap-based ratios are null. The regime's `/global` call also fails (dominance null, handled). Source conflicts can't be checked and aren't logged.
- **Unmatched log:** a degraded run never asked CoinGecko, so it neither opens nor resolves `no_coingecko_market_data` intervals (`diffUnmatched`'s `ignoreKinds`). Otherwise it would open ~680 intervals and resolve them all the next day.
- **Provenance:** the run's manifest says it (`buildLiveRunProvenance(.., {degraded: true})`): price from DefiLlama, and the CoinGecko fields "not fetched: CoinGecko unavailable". It never claims a source that wasn't called.
- **Queryable flag:** `screener_runs.degraded boolean not null default false`, with details in `notes.degradation` (the error, the price source, the null fields, skipped new assets, missing prices). **Status stays `ok`**: the day was captured, so it isn't a gap for the gap detector.
- **Same-day preference (extends "One run per UTC day"):** a complete `ok` run beats a degraded one for the same UTC day, whatever the order. `runSelection.ts` does this for runs, and `history.ts`'s `dailyReadings` does it for per-day readings. A degraded run represents its day only when nothing complete exists that day.
- **Phase 4 rule:** a backtest **excludes days whose representative run is degraded** (`degraded = true` on the run `pickRunPerUtcDay` returns). It doesn't substitute an earlier day or interpolate.
- **Page:** a degraded day shows a red notice (what's missing, why nothing is rated, the recorded error) instead of an unexplained empty table.
- **Quiet failure mode, documented: an invalid CoinGecko key doesn't error.** CoinGecko serves a request carrying an invalid `x-cg-demo-api-key` as the free public tier (live-checked 2026-09-23: a made-up key returned normal `/coins/markets` data). So a typo, a truncated paste, or a revoked key in `COINGECKO_API_KEY` / `COINGECKO_API_KEY_BACKUP` **fails silently into rate-limited public access**: fewer calls per minute, shared per-IP limits (unreliable from Vercel's shared IPs), and more 429s under load. Nothing says the key is wrong. If CoinGecko calls start 429ing without a monthly-cap error (10006), check the key values first. The degrade path above only engages if those calls then actually fail.
- **Verified live 2026-09-23** (forced-degraded run `d9685a55`; `scripts/diag/screener-degraded-verify.ts`, 11/11 checks; that run's notes carry the skipped-count field under its earlier name, `groups_skipped_not_yet_known`):
  - 682 rows, market cap and supply null on all of them, price on 603 (79 not priced by DefiLlama), fees on 638.
  - Nothing rated. No CoinGecko-kind unmatched intervals opened or resolved.
  - The same day's earlier complete run still wins run selection, **and** the history reader: for all 682 assets the complete reading is chosen. Under plain latest-wins, all 682 would have taken the degraded one.
  - The gap detector's query counts the degraded run, and a day covered only by it is not a gap.
- **Testing:** because an invalid key is served as the public tier, an outage can't be simulated from outside. `runScreenerSnapshot`'s test-only `forceDegraded` option (never passed by the cron route) and `scripts/diag/screener-live-run.ts --force-degraded` exercise the real path.

### Backfilled rows: what each value's real moment is (verified 2026-09-23)
A backfilled `screener_asset_snapshots` row is labeled with one date, but its values are **not from one moment**:
- **`observed_at`** is a nominal **12:00 UTC label** for the date, not the moment of anything in the row.
- **`price_usd`** (DefiLlama-priced rows): the backfill run's `/chart` grid, **the run's start time of day** (~21:31 for most). CoinGecko-fallback rows (`provenance_override` price source `coingecko`): **00:00**.
- **`market_cap_usd` / `volume_24h_usd`**: CoinGecko's daily point, **00:00**.
- **Fees/revenue**: flows, rolling sums of complete UTC days.

So a ratio **within** one row that mixes price with market cap (implied supply, dilution) mixes moments. Measured: market cap ÷ the stored price has 0.65% daily noise; ÷ the 00:00 price, 0.000%. Anything pairing a backfilled row with another series must use the value's real moment, not `observed_at` (the pairing code does: `pairBtc` by the run's grid). A latent hazard to keep in mind: `dailyReadings` orders a day's readings by `observed_at`, so a backfilled 12:00 label would "beat" a live 07:00 reading if both ever existed on one day. They don't today: the backfill ends the day before live history began.

### OPEN QUESTION AGAINST THE DESIGN: momentum as the primary ranking is unsupported by our own data (raised 2026-09-23, Phase 4 sign-off)
**Where it came from:** Score B (3-week and 12-week momentum vs BTC) was made the primary ranking because published research found cross-sectional momentum works in crypto (Liu, Tsyvinski & Wu). The Quality & Risk layer was demoted to a tier on the same premise.

**What our own backtest found** (run `d7cf95ae`; `PHASE_4.md` 4b):
- On the universe the screener actually rates (1 year, 9 periods), Score B's rank IC with the next 30 days' return vs BTC is about 0 (−0.024, CI [−0.10, +0.05]).
- On a wider 3-year universe (36 periods), it's **significantly negative in-sample**: −0.051, CI [−0.093, −0.009]; `mom_12w` is −0.053. That's reversal, not continuation.
- It fades to about 0 in the held-back third, so **no sign flip is justified**.
- **But the premise for momentum-as-primary is not supported by our own data.**

**What's open:**
- Whether the screener should rank at all before something passes a test.
- If it should, by what.
- Whether the difference from the published result is structural. Our universe is ~60–80 revenue-generating tokens, not a broad coin universe. We rebalance monthly, against BTC, not weekly. And momentum is ~ one feature among many, not a traded strategy.

**Until this is resolved,** the ranking stays but is presented as unvalidated: the banner, and a caption under it with the latest backtest's conclusion. Nothing downstream (Phase 5's "finalists", any weight) may treat the grade order as evidence of merit. The pre-registered hypotheses H1–H3 (`PHASE_4.md`) test this question on post-registration data only.

### Phase 4 — standing rules (2026-09-23; full plan and definitions in `PHASE_4_PLAN.md`)
- **The backtest never gets its own scoring implementation.** At each formation date it scores through the production path (`computeAssetMetrics`, `computeHistoryMetrics`, `scoreRun`, `config.ts`), the same functions the daily cron runs. A separate implementation would validate code we don't run. The same applies to the pieces around scoring: the per-day reading rule (`dailyReadings`), run selection (`pickRunPerUtcDay`), and BTC pairing (`pairBtc` with `loadBtcReference`, which takes a longer window for the backtest instead of being re-implemented).
- **Prediction before results:** the expected outcome is written into `PHASE_4.md` and stored in `screener_backtest_runs.prediction` when the run's row is inserted, before any result exists.
- **Activation needs the held-back third:** a candidate factor goes active only if its training and holdout mean ICs share a sign **and** the holdout 95% CI excludes 0. This isn't relaxed for a strong in-sample result.
- **No CoinGecko calls in Phase 4.**

### DefiLlama `/chart` dates are grid steps, not timestamp dates (bug found and fixed 2026-09-23)
DefiLlama jitters `/chart` point timestamps by about a minute either side of the requested grid. `fetchChartPrices` used to label each point with the **calendar date of its timestamp**. On a grid near midnight that crosses the date line: a 00:00 grid returned points at "12-23 23:59", "12-24 23:59", "12-26 00:00". So about half the points were labeled a day early, collided with the real previous day, and days dropped out (bitcoin had 1,024 of 1,215 days, and stored prices were off from the true 00:00 price by 2–10% on the shifted days).
- **Found** by spot-checking Phase 4's deep store against a different endpoint (`/prices/historical` at 00:00). The file's own read-back check passed, because it used the same library that wrote the file (the "different tool" rule again).
- **Fix:** points are labeled by their **grid step**, the nearest whole number of days from the requested start (`chartGridDate`, pure, tested with the real timestamps).
- **After the fix:** 1,215 of 1,215 days, and 12/12 spot checks match `/prices/historical` exactly.
- **Grids away from midnight label exactly as before**, so the backfill (~21:31 grid) is unaffected and its stored rows are unchanged.
- **Production impact:** 2b's BTC reference for **CoinGecko-priced backfilled rows** requested a 00:00 grid, so those rows could pair with BTC from the wrong day, or with none. That's 6,300 of 236,007 backfilled rows, in 186 assets; **0 of today's 72 rated assets are affected**. Unrated assets' displayed momentum and beta could have been off. The next daily run uses the fixed labels.

### Read-only table view
Built (Phase 1), sortable, flags conflicts and backfilled rows. **Moved to `/screener/universe` in 3b.** `/screener` is now the real screener (Phase 3b). Both stay URL-only (not in the sidebar) until Phase 4 validates something.

---

## Original v2 build prompt (base spec — read the amendments above first, they supersede the matching sections here)

# Build prompt: Crypto fundamental research pipeline (v2)

You are building a crypto research module that ranks tokens so I can find assets whose valuation looks disconnected from their fundamentals. The module has two separate scores: a fundamental score and a momentum/regime overlay. Both are built from standard, published metric definitions and ranked within each sector. No grade is trusted until a point-in-time backtest supports it.

**Keep from csp-screener:** hard gates, the "unrated" state, a layered write-up, a readable letter grade, and every number traceable to its source.

**Do not copy from csp-screener:** its expected-value math. That is designed for a single bounded options trade. This module is a cross-sectional ranking problem, so it uses a factor-style model instead.

## How we'll work

Work in phases. At the end of each phase:
1. Write a short report file (`PHASE_N.md`) covering what you built, what you verified, what surprised you, and any open questions.
2. STOP and wait for my sign-off. Do not start the next phase on your own.
3. Leave changes uncommitted for my review.

## Non-negotiable principles

1. **Numbers come from code, never from the LLM.** Every metric is computed from API data. The LLM (Phase 5) writes only text about numbers it is given.
2. **Null is not zero.** A missing value stays null and lowers confidence. It is never filled with 0.
3. **Every field carries provenance:** source, endpoint, and fetch timestamp.
4. **Flag source conflicts.** When two sources report the same field and differ by more than 5% (configurable), mark it `CONFLICT` and show both values. Never pick one silently.
5. **Use standard definitions.** Fees, revenue, earnings, P/F, and P/S follow Token Terminal's published definitions (see Phase 2). Don't invent private versions of standard metrics. Where DefiLlama's field definitions differ, document the mapping.
6. **Store history point-in-time.** Every stored value keeps the date it was observed. Never overwrite history with revised figures. Store revisions as new rows.
7. **No survivorship bias.** Tokens that die, delist, or drop out of the data stay in the history with a status flag. Never delete them.
8. **Read-only.** No wallet connections, no trading, no writes to external services.
9. **All thresholds and weights live in one config file.**
10. **Prefer free data.** I don't want a new monthly subscription. If a metric requires a paid source, tell me first and propose a free workaround.

## Phase 0: Recon and design (no feature code)

1. Read the csp-screener repo and summarize its stack, structure, data-fetching patterns, grading engine, and UI conventions.
2. Recommend where this should live: a module inside csp-screener, a sibling app sharing components, or part of my planned crypto portfolio web app. Give the tradeoffs and let me decide.
3. Verify each candidate data source with a live test call. For each, record the following in `DATA_SOURCES.md`, and mark anything that turns out to be paid or broken:
   - exact URL
   - whether it needs auth
   - rate limits
   - fields we'll use
   - a sample response
   - whether it's free

   Sources to check:
   - DefiLlama protocols list (`https://api.llama.fi/protocols`)
   - DefiLlama fees overview (`https://api.llama.fi/overview/fees`), data types dailyFees, dailyRevenue, dailyHoldersRevenue
   - DefiLlama per-protocol fee summary (`summary/fees/{protocol}`)
   - DefiLlama stablecoin supply history
   - CoinGecko coin markets, `/global`, and historical market data (free demo key). Check how far back free price history goes, since the backtest depends on it.
   - Hyperliquid info API: BTC/ETH funding and open interest
   - Token unlock/emissions data. DefiLlama emissions appears to be Pro-only. Investigate free alternatives and report back; don't build yet.
   - Token Terminal: check whether any free or public access exists for the incentives/earnings data. If not, document how we approximate earnings from free sources.
4. Map definitions: build a table showing how each DefiLlama field corresponds to Token Terminal's fees / revenue / earnings, and where they differ.
5. Propose a database schema designed for point-in-time history (append-only daily snapshots, revisions as new rows, status field for dead or delisted tokens).
6. Check historical backfill: can we get past daily values of fees, revenue, market cap, and price for the backtest? Report how many months are realistically available for free and whether that history is point-in-time or revised.

Deliverable: `PHASE_0.md` + `DATA_SOURCES.md`. Stop.

## Phase 1: Data layer and snapshot job (ship this first)

The snapshot job is the most time-sensitive piece. Every day it isn't running is a day of point-in-time history we can never get back.

1. Build fetchers with caching, retry/backoff, and rate-limit handling.
2. Build the universe:
   - every DefiLlama protocol with a token (gecko_id present) and fee data, joined to CoinGecko market data
   - log unmatched items to a file instead of dropping them
3. Build the daily snapshot job (append-only, with provenance) and schedule it.
4. Backfill whatever free history Phase 0 found. Tag each backfilled row `backfilled` so it's never confused with true point-in-time data.
5. Build a read-only table view of the raw universe for spot-checking against defillama.com and coingecko.com.

Deliverable: `PHASE_1.md` with universe size, match rate, conflict count, 5 spot-checked examples, and confirmation that the snapshot job is running. Stop.

## Phase 2: Regime, kill filters, and metrics

### Regime (market-wide, computed once per run)

Inputs:
- BTC dominance and its 4-week change
- ETH/BTC 4-week change
- total stablecoin supply 30-day % change
- average BTC/ETH funding rate
- BTC open interest trend

Starting label rules (configurable):
- `RISK_OFF`: stablecoin supply 30d change < 0 AND BTC dominance rising
- `BTC_LED`: BTC dominance > 58% and flat/rising, stablecoin supply flat
- `ROTATION`: BTC dominance falling > 1.5 pts over 4 weeks AND ETH/BTC rising
- `FROTH`: funding in the top decile of our stored history OR open interest rising much faster than price
- otherwise: `NEUTRAL`

Always show the inputs next to the label.

### Kill filters (hard gates, configurable)

Failing assets get `UNRATED` plus the reason. They are not dropped from the data.

| Gate | Starting default |
|---|---|
| Market cap floor | < $100M → unrated |
| Liquidity | 24h volume < $2M → unrated |
| Revenue floor | annualized 30d revenue < $5M → unrated |
| Unlock overhang | unlocks next 90d > 10% of circulating → unrated; 5–10% → flag |
| Collapsing revenue | 90d revenue down > 60% vs prior 90d → unrated |
| Missing core data | price, mcap, or revenue null → unrated ("insufficient data") |

> **AMENDED — see "Kill filter — market cap floor lowered" above: the market cap floor is $10M, not $100M.** Every other row in this table is unchanged.

### Standard metric definitions (Token Terminal conventions)

- **Fees:** total paid by users.
- **Revenue:** the portion of fees the protocol retains after supply-side payouts (LPs, validators, creators).
- **Earnings:** revenue minus token incentives/emissions (and cost of revenue / opex where known). If incentive data is unavailable, earnings is null and flagged as the key missing field. Do not fall back to revenue.

> **AMENDED — see "Quality & Risk" above: earnings is removed from v1 entirely, not carried as null.**

### Fundamental metrics

- `fees_ann`, `rev_ann`, `earnings_ann` = trailing-30-day value × (365 / 30)
- `pf_fd` = FDV / fees_ann; `pf_circ` = circulating mcap / fees_ann
- `ps_fd` = FDV / rev_ann; `ps_circ` = circulating mcap / rev_ann
- `earnings_yield` = earnings_ann / FDV. This can be negative, and negative is informative.
- `capture` = holders_revenue / revenue (null if not reported)
- `rev_growth` = (rev_30d_ann / rev_90d_ann) − 1
- `float_ratio` = circulating / max supply (or total supply if max is null)
- `unlock_overhang_90d` = unlocks next 90d / circulating supply
- `mc_tvl` = mcap / TVL (only where TVL is economically meaningful)

> **AMENDED**: `earnings_ann`/`earnings_yield` removed (see above). `buyback_yield` = annualized holders_revenue / market cap added as a new candidate factor (weight 0 pending Phase 4). `dilution_rate` (trailing circulating-supply growth rate) added, serving double duty as a Quality & Risk tier input and a separate weight-0 momentum-ranking candidate factor.

### Market factors (Liu, Tsyvinski & Wu, *Journal of Finance* 2022: market, size, momentum)

- `mom_3w`, `mom_12w` = price return over the window, measured relative to BTC
- `size` = log(circulating market cap), stored so we can see whether rankings just reflect size
- `beta_btc` = 90-day beta to BTC returns

> **AMENDED — data availability, see "Backtest price-history source" above**: `mom_3w`/`mom_12w`/`beta_btc` can use DefiLlama's deep price history (years). `size` (needs market cap) is capped at CoinGecko's ~365-day window.

### Sector mapping (config)

Only rank an asset on metrics that make sense for its category:
- Lending: ps, earnings_yield, capture, mc_tvl
- Perps / DEX: pf, ps, earnings_yield, capture
- Launchpads / trading apps: ps, earnings_yield, rev_growth
- Liquid staking: ps, capture, TVL share trend
- Oracles / infra: rev_growth only. Flag as "optionality"; don't score as cheap or expensive.
- L1 / L2: out of scope in v1. Label as such rather than grading badly.

> **AMENDED**: every `earnings_yield` reference above is dead — earnings doesn't exist in v1. This sector-metric mapping needs to be redone against the amended metric set (no earnings_yield; ps/pf now display-only weight-0 candidates, not live scoring inputs) when Phase 2 actually builds it — not redone here, flagging that the table above is stale, not a working mapping to implement as written.

Deliverable: `PHASE_2.md` with regime output, kill counts per gate, and a sample metrics table. Stop.

## Phase 3: Two scores, equal-weight composite

> **AMENDED — this entire phase's scoring design is superseded. See "Quality & Risk" and "Setup tags" above for what actually replaces it**: Quality & Risk is a tier (Pass/Caution/High risk), not a score, not equal-weighted, not z-scored. Score B (momentum) is primary. The text below is the original design for reference only — do not build it as written.

### Scoring method

Standardize each metric within its sector:
- use a cross-sectional z-score, winsorized at ±3 to limit outliers
- flip signs so "better" is always higher (e.g., a lower P/S gives a higher score)
- if a sector has fewer than 4 surviving assets, standardize against the full universe and flag it

Start with equal weights within each score. Weights change only after Phase 4 shows out-of-sample evidence, and each change is logged in a `WEIGHTS_CHANGELOG.md` together with the evidence behind it.

### Score A: Fundamental (answers "good business at a reasonable price?")

Equal-weight average of the available standardized components:
- Valuation: ps and pf (fully diluted and circulating)
- Earnings yield
- Value capture: capture, sign of earnings
- Growth: rev_growth
- Supply risk: unlock_overhang_90d and float_ratio (inverted, so more risk = lower score)

### Score B: Momentum and regime overlay (answers "is now a reasonable time?")

- Equal-weight average of mom_3w and mom_12w (vs. BTC)
- Plus a regime modifier from config. For example, `RISK_OFF` penalizes high beta_btc.

### Output per asset

- **Fundamental grade** A–F, from the Score A percentile across rated assets
- **Timing grade** A–F, from the Score B percentile
- **Setup tag:**
  - `QUALITY + TREND`: both strong
  - `POSSIBLY MISPRICED`: strong fundamentals, weak momentum, so wait for confirmation
  - `MOMENTUM ONLY`: weak fundamentals, strong momentum, so treat as speculative
  - `AVOID`: both weak
- **Confidence** (High / Medium / Low): the share of inputs present and conflict-free. An A with Low confidence must look visibly different from an A with High confidence.
- **Score breakdown** showing each component's contribution
- **Size check:** if the top-ranked list is dominated by one size bucket, flag it.

Until Phase 4 validates the grades, every view shows the banner: **"Unvalidated screen: grades are not yet backtested."** *(Amended 2026-09-23: after Phase 4 the wording is "Unvalidated screen: grades have not passed a backtest.", with a caption under it carrying the latest backtest run's date, id and one-line conclusion, read from `screener_backtest_runs.notes`.)*

Deliverable: `PHASE_3.md` with the full ranked list, setup-tag counts, and the top 15 with breakdowns. Stop.

## Phase 4: Backtest harness (before any weight tuning)

1. **Point-in-time only.** On each historical date, score using only data observed on or before that date. Use true snapshots where we have them and tagged backfill otherwise. Report the two separately.
2. **Universe as of each date,** including tokens that later died or delisted. Measure the dead-token share of the universe to quantify survivorship bias.
3. **Forward returns** over 30 and 90 days, measured against BTC and, as a secondary check, against an equal-weight basket of the rated universe.
4. **Tests:**
   - quintile or tercile spreads for each score and each component
   - rank IC (Spearman correlation between score and forward return) per period, with its mean and t-stat
   - hit rate of the `POSSIBLY MISPRICED` tag
5. **Controls:** check whether each score adds anything once size and momentum are controlled for. If the fundamental score is just a proxy for size, say so.
6. **Out-of-sample discipline:** hold back the most recent third of history. Any weight change proposed from the first two-thirds must hold up on the held-back third before it's adopted.
7. **Report honestly:** sample length, number of periods, confidence intervals. If the history is too short to conclude anything, say "inconclusive." Don't overstate.

> **AMENDED — additional, non-negotiable requirements from Phase 1 sign-off, on top of everything above**:
> - Run at **1yr, 2yr, and 3yr windows**, each reported with its own sample size and coverage rate. 1yr is primary (highest coverage, least biased); longer windows are robustness checks only. **If results flip between windows, report that — don't average across them.**
> - Every factor result must be labeled with which window it was actually tested on — `ps_fd`/`pf_fd`/`buyback_yield`/`size` are structurally capped near 365d (no historical mcap source exists, see the data-sources amendment above); only momentum factors (`mom_3w`/`mom_12w`/`beta_btc`) can genuinely use the deeper DefiLlama-sourced windows.
> - "hit rate of the POSSIBLY MISPRICED tag" is dead — that tag doesn't exist anymore. Test the new setup tags (LEADER/WATCH/SPECULATIVE/AVOID/NEUTRAL) instead, particularly whether LEADER/WATCH (Pass tier) actually outperform SPECULATIVE (Caution/High-risk tier, high momentum) — that's the closest analog to what the old tag was trying to validate.
> - The `dilution_rate`/P/S/P/F/`buyback_yield` weight-0 candidate factors (see "Candidate factor shape" above) need to be explicitly tested here, with `evidence_ref` populated from this phase's own results before any of them can move to `status: "active"`.

Deliverable: `PHASE_4.md` with results tables and a recommendation: keep equal weights, adjust (with evidence), or drop a component. Stop.

## Phase 5: Qualitative layer (LLM, finalists only)

1. Finalists: the top N by Fundamental score (default 10), plus any assets I pin manually.
2. Gather recent project announcements, governance posts, and news. Anchor every search prompt to project name, ticker, and a date window.
3. Send the LLM the metrics JSON, both grades, the setup tag, the regime label, and source snippets with URLs and dates.
4. Require strict JSON output:

```json
{
  "core_thesis": "string",
  "why_mispriced": "string",
  "catalysts": [
    {"event": "string", "date_or_window": "string", "status": "confirmed | speculative", "source_url": "string"}
  ],
  "competitors": [{"name": "string", "where_they_are_stronger": "string"}],
  "bear_case": ["string"],
  "invalidation_conditions": [{"condition": "string", "metric_key": "string or null", "threshold": "number or null"}],
  "what_could_i_be_wrong_about": ["string"],
  "citations": [{"claim": "string", "url": "string", "date": "string"}]
}
```

5. **Validator:** reject and retry any output containing a number that isn't in the input metrics or source snippets (dates excepted). Log rejections.
6. Drop any catalyst that lacks a source URL.

> **AMENDED**: "top N by Fundamental score" is dead terminology (no Fundamental score anymore) — should read "top N by Timing grade among Pass-tier assets" or similar, matching the new primary-ranking-is-momentum design. Not fully redefined here — a real decision Phase 5 needs to make explicitly when it's reached, not inferred silently.

Deliverable: `PHASE_5.md` with 3 sample write-ups and validator stats. Stop.

## Phase 6: Monitoring

1. Persist every run: regime, both scores, grades, tags, metrics, invalidation conditions.
2. Alert when a stored `metric_key` crosses its threshold on a later snapshot.
3. Re-run the Phase 4 backtest monthly as history grows. Show the latest rank IC and quintile spread on a "Model health" page.
4. Remove the "Unvalidated" banner only when I explicitly approve it after reviewing Phase 4 results.

Deliverable: `PHASE_6.md`. Stop.

## UI (build incrementally, matching csp-screener's look)

- **Header:** regime label and its inputs, plus the validation banner.
- **Main table:** Asset, Ticker, Price, Market Cap, FDV, Sector, Fundamental grade, Timing grade, Setup tag, Confidence, Key Metric, Biggest Risk.
- **Filters:** grade, sector, setup tag, and a toggle to show unrated assets with their reasons.
- **Drill-down per asset:** both score breakdowns, raw metrics with provenance and conflict flags, the fees → revenue → earnings waterfall, unlock info, and the Phase 5 write-up ending in "What could I be wrong about?"
- **Model health page:** backtest results, rank IC over time, history length.
- **Footer on every view:** "Research tool, not financial advice."

> **AMENDED**: "Fundamental grade" column → replace with **Quality & Risk tier** (Pass/Caution/High risk, not a letter). "the fees → revenue → earnings waterfall" → earnings doesn't exist, this becomes a fees → revenue waterfall only. Setup tag values are the new set (LEADER/WATCH/SPECULATIVE/AVOID/NEUTRAL). Scope note required on every view, per Phase 0 §8 #7: **"Covers revenue-generating app tokens only; BTC, ETH, L1s, and memecoins excluded by design."**

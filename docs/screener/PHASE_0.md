# Phase 0 — Recon and design (v2)

**Revision history**: pass 1 was written against v1 of the build prompt (arrived by mistake). Pass 2 replaced it against v2 in full and incorporated your first six decisions (§2-§7, each marked **DECIDED**). This pass (3) applies a methodology change to the scoring design, made before any of Phase 1-3 gets built — see §8. Nothing below has been built; every change so far is still a document, not code.

## What I built

Still recon-only — no feature code, nothing committed. Three documents now: `DATA_SOURCES.md` (updated with two new live-verified findings), this file, and nothing else. This pass adds the two v2 Phase 0 items that were missing (§5 Token Terminal mapping, §6 historical depth/point-in-time) and revises the schema (§7) and cron plan (§4) against your six decisions.

---

## 1. csp-screener — what's actually there

*(Unchanged from the v1 pass — still accurate, re-included for completeness.)*

Read directly: `lib/screener.ts`, `lib/risk-score.ts`, `lib/tradable-grade.ts`, three `earnings_history` provenance migrations, `components/screener-view.tsx`, `lib/earnings-capture.ts`, `OUTCOME_CAPTURE_SPEC.md`.

**Stack**: Next.js 14 App Router, Supabase, Tailwind + shadcn/ui, recharts + chart.js. `duckdb` is a devDependency for two scratch scripts querying local Parquet dumps — not part of the live app.

**Folders**: `app/` — one route segment per feature plus a parallel `app/api/*/route.ts` tree. `components/` (~90 files) — flat, one view/modal/panel per screen. `lib/` (~89 files) — per-source adapters (Schwab, Yahoo, EDGAR, Perplexity/Gemini) plus the grading modules. `migrations/` — 94 date-named plain-SQL files, no CLI. `scripts/`/`Test/` — ~230 one-off diagnostic scripts.

**Grading engine** (`lib/screener.ts`, 4175 lines): 4-stage typed pipeline. Hard gate returns literal "Unrated" text, never a forced letter — kept structurally distinct from a real low grade ("Unrated vs. capped-C... have two different causes," per the code's own comment). Risk score is a second axis, explicitly "display only, does NOT modify the grade," confidence-weighted by sample size.

**Best reusable pattern — not the grading engine**: the `earnings_history` provenance system — a 5-tier trust enum, a Postgres `BEFORE UPDATE` trigger that *rejects* trust-downgrading writes, an append-only rejection log, one designated writer module. Real, portable SQL — this is what's being ported per decision #1.

**Scheduling**: host-side macOS `launchd` hitting a `CRON_SECRET`-protected route — external to Vercel, nothing in `vercel.json`.

---

## 2. Placement — **DECIDED: (C), approved**

Building inside cryptoport as its own `/screener` route, with the namespacing plan from the v1 pass: `src/lib/screener/*`, `(app)/screener/` as its own route group, every new table prefixed `screener_`, hard one-way rule that `src/lib/screener/*` is never imported by portfolio code (wallets/holdings/watchlist). Porting the `earnings_history` provenance trigger — see §7 for how it's adapted to this schema's conflict-detection needs.

---

## 3. Data sources

Full detail in `DATA_SOURCES.md`. Since the v1 pass: added Token Terminal (confirmed paid, no free tier — live 403), and two new historical-depth findings (§6 below). Summary unchanged otherwise: 6 of 8 checked sources free and live-verified; token unlocks confirmed not free (DefiLlama `/emissions` → live HTTP 402); Token Terminal confirmed not free (live 403).

---

## 4. Cron — **DECIDED: Vercel Cron, approved**

**A cron job already exists and works on this exact project** — found while checking plan limits, not something I set up: `/api/cron/snapshot` (0 6 * * * UTC), an existing, unrelated daily job for `portfolio_snapshots` (per-user portfolio value history), `CRON_SECRET`-gated the same way csp-screener's routes are. This is direct, live proof the mechanism works on this account — not something I'm inferring from docs.

**Plan limits — partially confirmed, one honest gap**: I could not pull the exact current Hobby-vs-Pro cron-count/frequency ceiling through the tools available this session (the Vercel MCP tool's `get_project` had a parameter-schema mismatch I couldn't work around; Vercel's own doc-search tool returned only code snippets, not the pricing/limits prose). What I *can* say with direct evidence: `maxDuration = 300` is already live in production on two other cryptoport routes (confirmed deployed and returning 200 earlier this session) — Hobby's function-duration ceiling has historically been far below that, so this is strong indirect evidence the account is already on a plan that supports what a second, heavier cron needs. Recommend a 10-second glance at Vercel dashboard → Settings → Cron Jobs for the authoritative current number rather than me asserting one I can't verify live.

**Function budget / batching**: the existing snapshot cron uses `maxDuration = 60` (cheap — no network calls, pure in-memory aggregation over already-fetched data). The screener's daily job is a different shape — real network calls across the DefiLlama-matched universe (likely low hundreds of protocols once narrowed to "has `gecko_id` and fee data," out of DefiLlama's 8,325 total). Plan: `maxDuration = 300` (matching cryptoport's existing precedent for real-network-call routes) with `mapWithConcurrency`-capped fetches (the same concurrency-and-backoff discipline already used for CoinGecko/Coinbase elsewhere in this app). If the universe ever grows past what fits in one 300s window, the fallback is a cursor-based continuation (store how far the run got, self-trigger a second invocation) rather than raising `maxDuration` indefinitely — not needed at today's likely universe size, flagged for later if it becomes one.

**Missing-day gap detector**: since `screener_runs` (§7) stamps one row per pipeline execution with `started_at`/`finished_at`/`status`, a missed day is just an absent (or non-`ok`) row for that date. Plan: a small `detectSnapshotGaps()` check — look back N days from today, list any date with no successful run — called as a cheap self-check at the start of every cron invocation (so a gap shows up in that run's own logs/notes immediately, not just when someone happens to look), with the same check exposed read-only in the screener UI later if useful. This directly needs the append-only, `observed_at`-based design in §7 to mean anything.

---

## 5. DefiLlama → Token Terminal definition mapping

Token Terminal's published fees/revenue/earnings framing is well-established, widely-cited terminology in crypto data circles — but I want to be honest about sourcing: several attempts to fetch Token Terminal's own glossary text this session hit dead links (`/docs/catalog/financial-statements` → 404) or generic nav pages with no definitional prose. What follows is the standard industry-consensus version of these definitions, not a definition I independently confirmed by reading Token Terminal's own page today. DefiLlama's API also has no machine-readable per-protocol methodology field (`methodology`/`methodologyURL`/`breakdownMethodology` all `null`, checked live across lending/DEX/perps) — so the mapping below is a conceptual + empirical match, not a field-level guarantee.

| Token Terminal concept | Standard definition | DefiLlama field | Fit |
|---|---|---|---|
| **Fees** | Total amount paid by end users of the protocol (gross, before any split) | `dailyFees` | Good conceptually. Per-protocol methodology not independently verifiable via API — recommend a Phase 1 spot-check against 2-3 protocols' own published numbers. |
| **Revenue** | Portion of fees the protocol retains after paying supply-side participants (LPs, lenders, validators) | `dailyRevenue` | Good — and empirically consistent: live Aave numbers show fees $1.35M/day vs. revenue $172K/day (~87% flows to lenders as the supply side), matching this exact definition's shape. |
| **Earnings** | Revenue minus the cost of token incentives/emissions paid out (and other opex where known) | **No DefiLlama field.** `dailyHoldersRevenue` measures something different — money flowing *to* holders (buybacks, staking rewards funded by revenue), not the *cost* of incentives paid *out* to attract usage. These are different axes, not substitutes. | **Real gap.** |

**This was the single most important finding in this pass**: `earnings`/`earnings_yield` had **no computable value from DefiLlama data** for essentially any protocol in the universe. **Resolved by the methodology change in §8**: earnings is removed from v1 entirely rather than carried as a mostly-null field — this finding is why. `pf`/`ps` have no such gap — both map cleanly to `dailyFees`/`dailyRevenue` with no missing piece — and per §8 they're kept, just moved to display-only.

---

## 6. Historical data depth & point-in-time vs. revised

**CoinGecko — hard 365-day ceiling, live-confirmed at the exact boundary**: `days=365` → 200 OK, 366 rows. `days=366` → **HTTP 401**, `"Public API users are limited to querying historical data within the past 365 days."` This is an enforced ceiling, not a soft default. It directly caps how far back `mom_3w`/`mom_12w`/`beta_btc` (and any price-based backtest input) can reach via backfill.

**DefiLlama fees/revenue — deep, free**: `totalDataChart` on Aave returned **2,119 daily rows back to 2020-12-04**, live-confirmed — nearly 5 years, free. Stablecoin supply history: 3,220 daily rows (confirmed in the v1 pass). Both are far deeper than CoinGecko's price ceiling.

**Point-in-time vs. revised — the honest gap**: "how deep does the chart go today" and "was this true point-in-time history" are two different questions, and I could only answer the first one this session. Confirming whether DefiLlama silently revises historical `totalDataChart` values when it fixes an adapter/methodology bug (a documented characteristic of DefiLlama's TVL charts historically, from general knowledge — not something re-verified live, since that would require diffing the same historical date's value across two separate points in time, weeks apart) is not something a single session can test. Same open question for CoinGecko's historical `market_chart` — if they correct a bad print, a query today for a date 200 days ago reflects today's corrected value, not what would have been returned 200 days ago.

**Practical consequence, matching the spec's own Phase 1 §4 and Phase 4 §1**: any value obtained by looking *backward* through these APIs — however deep the chart goes — gets `is_backfilled = true` and is never treated as equivalent to a row captured by our own job *on the day it happened*. True point-in-time history starts accumulating at 1 day per day from whenever Phase 1's snapshot job first runs; everything before that is backfilled (deep, but of uncertain revision-safety) and must be reported separately in Phase 4, exactly as the spec already requires. One concrete number worth having now: even with full backfill, the *weakest* link for any price-return-dependent backtest (momentum, beta, and forward-return measurement itself) is CoinGecko's 365-day ceiling — so Phase 4's price-based tests are capped near ~365 days of backfilled history plus whatever true point-in-time history has accumulated by then, regardless of how deep the fee/revenue side goes.

---

## 7. Revised schema — **DECIDED items incorporated**

Decision #6 asked for: append-only with `observed_at`, revisions as new rows (not overwrites), a status field for dead/delisted tokens, a `backfilled` flag, and every scoring run stamped with its config/weights version. All below. Decision #5: RLS stays enabled on every table — public read policy, no client write policies (service-role-only writes, since an absent policy on a given operation means denied-by-default under RLS). Decision #2's manual unlock table is included. Every table name prefixed `screener_` per the placement decision.

```
screener_assets                    -- dimension, one row per token/protocol, NEVER deleted
  id, gecko_id (unique), defillama_slug (nullable),
  name, ticker, sector,
  status text not null default 'active'   -- 'active' | 'delisted' | 'dead' | 'unknown'
  first_seen_at, last_seen_at, status_changed_at

screener_asset_snapshots            -- RAW fetched values, append-only
  id, asset_id (fk), observed_at (timestamptz — not date, so a same-day
    revision is a new row, never an overwrite), run_id (fk),
  is_backfilled boolean not null default false,
  price_usd, market_cap_usd, fdv_usd,
  circulating_supply, total_supply, max_supply,
  tvl_usd, fees_24h/7d/30d/1y, revenue_24h/7d/30d/1y,
  holders_revenue_24h/30d, volume_24h_usd
  provenance JSONB                  -- {field_name: {source, endpoint, fetched_at}}
  -- NO unique constraint on (asset_id, date): "value as of date D" = latest
  -- observed_at <= D per asset, per field. This is what makes Phase 4's
  -- point-in-time backtest possible at all.

screener_field_conflicts             -- principle #4, narrow + queryable
  id, asset_id, observed_at, field_name,
  source_a, value_a, source_b, value_b, pct_diff, run_id

screener_runs                         -- one row per pipeline execution
  id, started_at, finished_at, status,
  universe_size, matched_count, unmatched_count, notes

screener_unmatched_log                 -- Phase 1's "log, don't drop"
  id, run_id, kind, identifier, reason, created_at

screener_manual_unlocks                 -- DECISION #2: finalists only, hand-entered
  id, asset_id, unlock_date, amount, token_denomination,
  source_url, entered_at, entered_by, notes
  -- absence of rows here = gate status UNKNOWN, never PASS (decision #2)

screener_regime_snapshots                -- one row per run
  id, run_id, label, btc_dominance, btc_dominance_4w_change,
  eth_btc_4w_change, stablecoin_supply_30d_change_pct,
  avg_funding_rate, oi_trend, computed_at

screener_scoring_config_versions          -- DECISION #6: every weight/threshold set, versioned
  id, version_label, weights JSONB, thresholds JSONB,
  effective_from, notes, created_at

screener_asset_metrics                     -- Phase 2 output, computed FROM snapshots
  id, asset_id, run_id, computed_at,
  fees_ann, rev_ann,                        -- earnings_ann REMOVED per §8 decision #1
  pf_fd, pf_circ, ps_fd, ps_circ,           -- §8 #2: display-only, weight 0 until Phase 4
  buyback_yield,                            -- §8 #5: NEW, display-only, weight 0 until Phase 4
  dilution_rate,                            -- §8 #3: trailing circulating-supply growth rate —
                                             -- computed from our own accumulating snapshot
                                             -- history, the same signal already proposed as the
                                             -- free unlock-detection workaround, now formalized
  capture, rev_growth, float_ratio, unlock_overhang_90d, mc_tvl,
  mom_3w, mom_12w, size, beta_btc,
  gate_status JSONB,                        -- {gate_name: "pass"|"fail"|"unknown", reason}
  sector_used

screener_asset_scores                       -- Phase 3 output, config-versioned
  id, asset_id, run_id, config_version_id (fk -> scoring_config_versions),
  quality_risk_tier,                        -- §9 #1: 'pass' | 'caution' | 'high_risk' —
                                             -- a TIER, not a score, per this round's decision
  quality_risk_reasons JSONB,               -- [{rule, value, threshold}, ...] — every triggered
                                             -- rule, not just the worst one, so the tier is
                                             -- never a black box (same discipline the regime
                                             -- label already has: "show the inputs next to it")
  timing_score,
  timing_grade_raw,                         -- pure Score B percentile, uncapped
  timing_grade,                             -- FINAL grade shown: timing_grade_raw, capped at
                                             -- C when quality_risk_tier = 'high_risk' (§9 #2).
                                             -- Storing both, not just the final value, so a
                                             -- capped C is traceable to "would've been a B" —
                                             -- the same "every number traceable" principle the
                                             -- rest of this schema already follows.
  setup_tag,                                -- §9 #2: LEADER | WATCH | SPECULATIVE | AVOID |
                                             -- NEUTRAL — POSSIBLY MISPRICED removed everywhere
  confidence,
  score_breakdown_timing JSONB,
  size_check_flag boolean, created_at
  -- quality_risk_score/quality_risk_grade/score_breakdown_quality_risk from the previous
  -- pass are REMOVED — Quality & Risk no longer produces a score or letter grade at all.

screener_asset_research                      -- Phase 5, LLM layer — on-demand, NOT per-run
  id, asset_id, status, started_at, computed_at,
  core_thesis, why_mispriced, catalysts JSONB, competitors JSONB,
  bear_case JSONB, invalidation_conditions JSONB,
  what_could_i_be_wrong_about JSONB, citations JSONB,
  validator_rejection_count
  -- mirrors cryptoport's existing token_analyses/trend_explanations
  -- claim -> after() -> store shape exactly

screener_invalidation_alerts                  -- Phase 6
  id, asset_id, metric_key, threshold, condition_text,
  triggered_at, triggering_snapshot_id, acknowledged

screener_backtest_runs                         -- Phase 4
  id, run_at, holdout_start_date, universe_asof_policy,
  results JSONB, notes                        -- quintile spreads, rank IC per period, controls
```

**RLS pattern, applied identically to every table above** (decision #5):
```sql
alter table screener_<name> enable row level security;
create policy "screener_<name>: public read" on screener_<name> for select using (true);
-- no insert/update/delete policy at all — under RLS, an absent policy for
-- an operation means denied by default, so only the service-role client
-- (which bypasses RLS entirely) can ever write. Matches how cron routes
-- already authenticate (CRON_SECRET) rather than relying on RLS for that.
```

**The `earnings_history` provenance trigger, ported** (decision #1): applies to `screener_asset_snapshots`' provenance-sensitive fields the same way csp-screener applies it to `earnings_history` — a trust-tier enum on `provenance` entries (e.g. `on_chain_direct > vendor_computed > estimated`), a `BEFORE INSERT` trigger (not `UPDATE`, since this table is append-only — the trigger's job here is to log a conflict row to `screener_field_conflicts` when a new observation disagrees with the most recent one by more than the configured threshold, not to block the insert), and the single-designated-writer convention (`src/lib/screener/snapshot-writer.ts` is the only file allowed to write to this table).

---

## 8. Methodology change — Quality & Risk / Score B primary (this pass, before Phase 1)

Applied to the schema in §7 already. Recording the reasoning and one interpretation I made that needs your confirmation, since two of your points (3 and 6) read as being in tension and I resolved that tension a specific way rather than silently picking one reading.

1. **Earnings removed from v1 entirely** — resolves §5's finding directly: it had no computable value from DefiLlama for nearly the whole universe, so it's gone rather than carried as a mostly-null field. `earnings_ann` dropped from `screener_asset_metrics`.
2. **Valuation metrics → display-only.** `pf_fd`, `pf_circ`, `ps_fd`, `ps_circ` stay computed and shown, but carry weight 0 in any score until Phase 4 shows predictive value. This needs a config-level representation, not just a code convention — `screener_scoring_config_versions.weights` should carry an explicit `active: boolean` (or a literal `0`) per factor, so "computed and displayed but not scored" is a real, auditable config state, not an implicit omission from the weighting code.
3. **Score A renamed "Quality & Risk."** Components: `dilution_rate`, `unlock_overhang` (`UNKNOWN` when no data — matches decision #2's own "never pass with no data" rule from the last round, now feeding a score too, not just a gate), revenue trend/collapse, and value-capture status (from the `KNOWN_HOLDER_VALUE_MECHANISMS` config proposed last round — categorical: has-mechanism / no-mechanism / unknown, not the raw `capture` ratio). Explicitly **not** a return-predicting composite — its job is filtering and risk-flagging.
4. **Score B (3w/12w momentum vs. BTC) is now the primary ranking signal** — a real shift from the original spec, where Score A ("good business at reasonable price?") and Score B ("is now a good time?") read as two co-equal axes feeding a joint setup tag. Flagged the knock-on effect on the original setup tags here; **resolved in §9** — new tag set (`LEADER`/`WATCH`/`SPECULATIVE`/`AVOID`/`NEUTRAL`), `POSSIBLY MISPRICED` removed.
5. **New candidate factor `buyback_yield`** = annualized `holders_revenue` / market cap. Computed and displayed, weight 0 until Phase 4. Same open dependency as the existing `capture` metric: `dailyHoldersRevenue`'s 0-vs-not-tracked ambiguity (§DATA_SOURCES.md) means `buyback_yield` should be `null`, not `0`, for any protocol not in the `KNOWN_HOLDER_VALUE_MECHANISMS` config from the last round — the two metrics share that one open dependency, not two separate ones.
6. **Phase 4 must test exactly four candidate factors** — P/S, P/F, `buyback_yield`, `dilution_rate` — for predictive power, controlling for size and momentum, and report which (if any) earn nonzero weight.

   **Flagged as a tension needing confirmation; resolved in §9.** Quality & Risk is now explicitly a tier (Pass/Caution/High risk), never a score — `dilution_rate` drives a tier threshold there, and separately remains a weight-0 candidate factor in the momentum ranking (Score B) until Phase 4 tests it. One job each, no more ambiguity.
7. **UI scope note**: "Covers revenue-generating app tokens only; BTC, ETH, L1s, and memecoins excluded by design." This is honest labeling of a boundary that already exists structurally (the universe is built from DefiLlama protocols with `gecko_id` + fee data — BTC/ETH/L1s/memecoins were never going to have fee data to join on), not a new filter. Recorded as a UI requirement for whichever phase builds the header.

---

## 9. Quality & Risk becomes a tier; setup tags replaced (this pass — resolves §8's two flagged tensions)

### Quality & Risk: Pass / Caution / High risk, not a score

This fully resolves §8 #6's flagged ambiguity: `dilution_rate` now has exactly one job inside Quality & Risk — driving a tier threshold, never a weighted score, since Quality & Risk no longer produces a score at all. Its second, separate job — as a Phase 4 candidate factor with weight 0 in **the momentum ranking (Score B)** until tested — is unaffected and now has an unambiguous home to earn weight in, since Quality & Risk itself has none to earn.

**Tier rules** (config-held thresholds, `screener_scoring_config_versions.thresholds`), evaluated worst-tier-wins (an asset triggering any High-risk rule is High risk regardless of which Caution rules also fire):

| Tier | Triggers (any one fires) |
|---|---|
| **High risk** | `dilution_rate` > 25%/yr, OR unlocks next 90d > 5% of circulating, OR revenue down > 40% vs. prior 90d |
| **Caution** | `dilution_rate` > 10%/yr, OR unlock status `UNKNOWN`, OR value-capture status paused/conditional |
| **Pass** | none of the above fire |

Every triggered rule is stored (`quality_risk_reasons`), not just the tier that resulted — an asset can be High risk for one reason while a reader also wants to see it's additionally in Caution territory on a second axis.

**One observation, not a question**: the original Phase 2 kill-filter table (still separate and still in effect) already hard-gates unlock overhang > 10%/90d to `UNRATED` — stricter than this tier's 5% High-risk trigger, so anything that hits the kill-filter's `UNRATED` would trivially also be High risk if it were rated. That's harmless, not a conflict: the kill filter answers "can we evaluate this at all" (excludes from ranking entirely), Quality & Risk answers "given we can, how much to trust it" (flags, never excludes) — the same two-layer separation csp-screener's own Unrated/capped-C design was built on, which is exactly where this whole project started.

**`KNOWN_HOLDER_VALUE_MECHANISMS` config, revised** — "paused/conditional" as a Caution trigger means the config needs more than a yes/no per protocol:

```ts
export const KNOWN_HOLDER_VALUE_MECHANISMS: Record<string, {
  status: "active" | "paused" | "conditional";
  mechanism: string;
  sourceUrl: string;
  lastVerified: string;
}> = {
  // still empty — needs your entries, per the same caveat as before: my
  // training data has real staleness risk here (cutoff Jan 2026, it's
  // Sept 2026 now), and these mechanisms change (fee switches get voted
  // on and reversed).
};
```
A protocol absent from this config = no known mechanism at all, which is its own (fourth) implicit status, not folded into "paused."

### Setup tags: LEADER / WATCH / SPECULATIVE / AVOID / NEUTRAL

"Momentum third" = Score B percentile tercile among rated (non-`UNRATED`) assets, per the original spec's own percentile-based grading. Full 3×3 grid, made explicit so nothing is left to infer:

| Quality & Risk tier \ Momentum tercile | Top third | Middle third | Bottom third |
|---|---|---|---|
| **Pass** | LEADER | NEUTRAL | WATCH |
| **Caution** | SPECULATIVE | NEUTRAL | NEUTRAL |
| **High risk** | SPECULATIVE | NEUTRAL | AVOID |

`POSSIBLY MISPRICED` is removed everywhere it appeared, including in this file's own §8 #4 reference to the old four-tag set — the model no longer claims to detect mispricing, only momentum + risk tier.

**Letter grade** = `timing_grade_raw` (Score B percentile — exact percentile→letter breakpoints are unchanged from the original v2 design, still Phase 3's job to set). **High risk caps the displayed grade at C**, regardless of what the raw percentile implies; **Caution does not cap anything** — it only participates in the setup-tag grid above. Both `timing_grade_raw` and the final capped `timing_grade` are stored (see §7's schema comment) so a capped C is auditable back to "this was really a B," not a silent downgrade.

---

## Decision #3 — holders-revenue methodology, investigated per your instruction

You asked me to check whether the fee summary response includes a per-protocol holders-revenue methodology entry, and report back before building `capture` — not decide unilaterally. Checked live: **no such field exists.** `methodology`, `methodologyURL`, and `breakdownMethodology` were all `null` across all three protocol types tested (Aave/lending, Uniswap/DEX, Hyperliquid/perps) — this isn't a gap in one protocol's data, it's absent from the endpoint's schema entirely.

Per your own fallback instruction, proposed a hand-curated config — shape finalized in §9 (revised there to a `status: "active"|"paused"|"conditional"` enum instead of a plain yes/no, since decision 1 in this round's message needs "paused/conditional" as a real, distinguishable state, not just presence/absence). A protocol **not** in the config gets `capture`/`buyback_yield` = `null` (never `0`), matching principle #2. A protocol **in** the config still uses DefiLlama's live `dailyHoldersRevenue` for the actual number — the config only answers "does a mechanism exist, and is it currently live," not the dollar figure itself, keeping the hand-curated part minimal (status + citation, not maintained numbers) and the numbers themselves still coming from code per principle #1. Still needs your review/additions before Phase 2 builds `capture`/`buyback_yield`/the Caution tier against it — deliberately left empty.

---

## What I verified (this pass)

- Token Terminal API requires auth — live 403, not assumed from pricing copy.
- CoinGecko's 365-day historical ceiling — tested the exact boundary (365 works, 366 fails) rather than trusting the first error message alone.
- DefiLlama's per-protocol methodology fields are genuinely absent from the API (not just unpopulated for one protocol) — checked across 3 different protocol types.
- Aave's `totalDataChart` depth (2,119 rows, back to Dec 2020) — read directly from the already-cached live response, not estimated.
- A Vercel Cron job already runs successfully on this exact project (`vercel crons ls`) — direct proof the mechanism works here, found while checking plan limits, not assumed.

## What surprised me

- `earnings` — one of Score A's two headline valuation legs — has no free-data path at all for nearly the entire universe. This isn't a rare null; per §5, it's close to the default state, and needs to be designed for as such rather than discovered later as "why is everything's earnings_yield blank."
- cryptoport already has a working cron (`/api/cron/snapshot`) I wasn't aware of before checking — unrelated to this build, but directly useful as both a proof-of-mechanism and a naming-collision check (the new job needs a distinct path, e.g. `/api/cron/screener-snapshot`, not `/api/cron/snapshot`).
- DefiLlama's fee/revenue history goes back nearly 5 years for a major protocol like Aave — deeper than I expected going in — but CoinGecko's hard 365-day price-history ceiling turns out to be the actual binding constraint on the backtest, not DefiLlama's depth.

## Open questions carried forward

*Resolved this pass: earnings-null-by-default (§8 #1, removed entirely). Resolved last message: the `dilution_rate` flag-vs-candidate-factor tension and setup-tag semantics — both fully specified now in §9 (tier rules, the 3×3 setup-tag grid, letter-grade capping).*

1. **`KNOWN_HOLDER_VALUE_MECHANISMS` config** (§9) — needs your review/additions before Phase 2 builds `capture`/`buyback_yield`/the Caution tier against it; deliberately left as a shape, not populated content.
2. **`weights JSONB` config shape for "computed, weight 0" vs. "active"** (§8 #2, for P/S, P/F, `buyback_yield`, and `dilution_rate`-as-momentum-factor) — confirming an explicit `active`/weight-0 field per factor is the right representation before Phase 2 builds the config file it lives in.
3. **Exact Vercel plan cron limits** — strong indirect evidence (existing cron + `maxDuration=300` already live) but couldn't pull the authoritative current number through available tooling; a quick dashboard glance would close this out.
4. **New cron route naming** — `/api/cron/screener-snapshot` (or your preferred name) to avoid colliding with the existing `/api/cron/snapshot`.

---

## 10. Two final items before Phase 1 (this pass)

### Holders-revenue config — entries not received

You referenced six attached entries (HYPE, PUMP, SKY active; AAVE paused; ENA, LDO conditional) — no attachment actually came through on that message (no file reference, nothing to read). Not fabricating `sourceUrl`/`mechanism` text for these myself — that would defeat the entire point of this config existing. What I *can* and did record: the rule.

```ts
export const KNOWN_HOLDER_VALUE_MECHANISMS: Record<string, {
  status: "active" | "paused" | "conditional";
  mechanism: string;
  sourceUrl: string;
  as_of: string; // ISO date
}> = {
  // still empty — six entries pending re-send
};

// Any entry with `as_of` older than 60 days is treated as a Caution
// trigger in its own right ("value-capture status stale") — added to
// the Caution rule list in §9 alongside the existing three:
// dilution_rate > 10%/yr, unlock status UNKNOWN, status paused/conditional.
```

Doesn't block Phase 1 — this config is only consumed by Phase 2's Quality & Risk tier and `capture`/`buyback_yield`, neither of which Phase 1 touches. Resend the six entries before Phase 2 needs them.

### Candidate factor shape — recorded, resolves last round's open item #2

```ts
export interface CandidateFactor {
  factor: string;                              // "ps" | "pf" | "buyback_yield" | "dilution_rate"
  weight: number;                               // 0 until moved to "active"
  status: "candidate" | "active" | "rejected";
  evidence_ref: string | null;                  // e.g. a screener_backtest_runs.id — required non-null to go active
  changed_at: string;                           // ISO timestamp of the last status/weight change
  note: string;
}
```
**Enforced, not just documented**: a factor can only move to `status: "active"` if `evidence_ref` is non-null — this is a real validation check in whatever writes `screener_scoring_config_versions`, not just a convention. P/S, P/F, `buyback_yield`, and `dilution_rate`-as-momentum-factor all start `candidate`, weight 0, `evidence_ref: null`.

**Config hash**: `screener_scoring_config_versions` gains `config_hash` (SHA-256 of the canonical-serialized `weights` + `thresholds`, computed once at version-creation time — the source of truth for "did this config actually change"). "Stamp every scoring run" is satisfied via `screener_asset_scores.config_version_id`'s existing FK rather than duplicating the hash onto every per-asset row — flagging one real ambiguity this surfaced: `screener_runs` (Phase 1's snapshot-pipeline-execution log) and a future scoring pass aren't obviously the same "run" concept once Phase 2/3 exist (a scoring pass could re-run against one day's snapshot under a different config for backtesting, independent of the snapshot cadence) — likely needs its own `screener_scoring_runs` table when Phase 2 gets built, not decided now since it isn't needed yet.

---

Both recorded. Proceeding to Phase 1 per your instruction — snapshot job, then universe join, then tagged backfill, then the read-only table, in that order. Nothing above is built yet as of this line; `PHASE_1.md` covers what actually gets built.

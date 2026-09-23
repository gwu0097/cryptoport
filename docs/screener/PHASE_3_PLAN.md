# Phase 3 plan — tiers, Score B, grades, setup tags

Proposed 2026-09-23 after the first scheduled 07:00 UTC run (`8798244f`) checked out; **every decision below accepted as recommended, same day.** What was actually built and verified is in `PHASE_3.md`; this file is the agreed scope.

Split like Phase 2: **3a** = compute + table + cron hook (one commit), **3b** = the UI (its own commit, after sign-off on 3a).

## Scope

1. **`src/lib/screener/scores.ts`** (pure, tested) — for each run's rated assets:
   - **Quality & Risk tier**, worst-wins; a rule with a null input doesn't fire; every rule's outcome + input stored (`quality_risk_rules`) with its coverage (`rules_evaluable`, "k of 4").
   - **Score B**, its percentile, `timing_grade_raw` and `timing_grade` (High risk caps at C), momentum tercile, **setup tag** (3×3 grid in SPEC), confidence, per-component breakdown, market-cap size bucket.
2. **`screener_asset_scores`**, keyed `(run_id, asset_id)` + `config_version_id`, same shape as `screener_asset_metrics`; 90-day retention via `scripts/screener-archive.ts --table scores`.
3. **Cron hook**: `derive.ts` scores right after metrics and regime, isolated (`notes.derivations.scores` / `scores_error`), with the run-level size check and output-shape warnings recorded there.
4. **(3b)** The real `(app)/screener` page: ranked sortable table, regime card with inputs + coverage, the always-on banner **"Unvalidated screen: grades are not yet backtested."**
5. `PHASE_3.md`, SPEC amendments, one commit per sub-phase.

## Decisions (all accepted 2026-09-23)

| # | Decision | Why |
|---|---|---|
| 1 | **Reuse `screener_runs`** via `run_id`; no separate scoring-runs table (closes HANDOFF open item 3) | Scores are computed in the same cron invocation as metrics; a config change already mints a new `config_version_id`. A separate table only earns its place if scoring ever runs on its own cadence (e.g. Phase 4 re-scoring history). |
| 2 | **Percentiles across all rated assets**, not per sector | ~74 rated; yield and liquid_staking have exactly 4 each, so per-sector ranks would mostly fall back to the universe anyway. |
| 3 | **Score B = mean of the two momentum legs' percentile ranks** (`mom_3w`, `mom_12w`); both missing → unscored (null). **Revised 2026-09-23:** one missing leg = "insufficient history" — scored and placed against the full-history distribution, but no grade, tercile or tag; ranking population is full-history assets only | Momentum is heavy-tailed (p90 `mom_12w` ≈ +95%); ranks need no winsorizing. The original one-leg fallback put one-leg assets at the extremes by construction (see PHASE_3.md). |
| 4 | **Grade cutoffs 80/60/40/20** → A/B/C/D/F, `validated: false` | Starting values until Phase 4. |
| 5 | **Regime modifier slot built, every value 0**; non-zero requires an `evidence_ref` (enforced by `validateConfig`) | An untested weight; the spec's own rule is weights change only with Phase 4 evidence. Moot until ~2026-10-20 anyway (label can only be NEUTRAL). |
| 6 | **Confidence**: high = both legs + no price/mcap source conflict; medium = one of those missing; low = both. **Tier-rule coverage shown separately**, not folded in | Dilution/unlock rules can't be evaluated for anyone until ~2026-12-21 — folded in, every asset would read "medium" and it would carry no information. |
| 7 | **Size check**: flag when one market-cap bucket (<$100M / $100M–$1B / >$1B) holds **>60%** of the top tercile | Run-level flag in `notes.derivations.scores.size_check`. |
| 8 | **Defer `screener_manual_unlocks`** (finalists-only, per Phase 0) | Consequence: the unlock gate and unlock tier rule stay not evaluable for all of Phase 3. |
| 9 | **`/screener` stays URL-only** (not in the sidebar) until Phase 4 validates something | Unvalidated grades shouldn't sit in primary navigation. |
| — | **Scope**: a `config.scopeOverrides` map (gecko_id → out_of_scope, with reason + date), **decided by a written rule** (SPEC, "Scope rule"): app/bridge revenue filed under a chain → out (NEAR, SOL, SUI, AVAX, APT); the protocol is the business or an L2's sequencer revenue → in. **Plus a diagnostic** listing rated assets CoinGecko tags L1/L2 for review — **never an automatic exclusion** | A manual map only catches the cases someone notices; a rule keeps the next call consistent. |

## Known effects, stated up front

- **The tier dimension is nearly inert until December.** Measured `dilution_rate` is null until ~2026-12-21 and no unlock data exists, so the only evaluable tier rule is revenue down >40% over 90d. Caution will be empty until ~12-21; almost every rated asset gets LEADER / NEUTRAL / WATCH from momentum alone.
- **~73 rated → terciles of ~24.** Thin; reported as such, not stretched.

## Verification

- Unit tests: all 9 tag cells, the cap-at-C case (a capped C still stores raw B/A), a null rule not firing, tercile/grade edges and ties, the one-leg fallback, modifiers inert at 0.
- A dry run on a real run's stored metrics (`scripts/diag/screener-score-preview.ts`).
- One live run through the real cron path, then an **independent recompute** of every stored score in plain JS (`scripts/diag/screener-score-verify.mjs` — no import of our scoring code or config).

## Out of scope

Any factor weight above 0; unlock data entry; Phase 4 (backtest) and Phase 5 (LLM write-ups).

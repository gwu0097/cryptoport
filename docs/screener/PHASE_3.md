# Phase 3 — tiers, Score B, grades, setup tags

## 3a — compute + table

Scope and the nine accepted decisions: `PHASE_3_PLAN.md`. 3a is committed, verified live and pushed (signed off 2026-09-23). 3b (the UI) is below.

## What I built

- **`src/lib/screener/scores.ts`** (pure). `scoreRun(ratedInputs, regimeLabel)` returns, per rated asset:
  - the tier plus all four rules, each with its outcome and input
  - `rules_evaluable`
  - Score B, its percentile, the raw and displayed grades, the tercile, the tag, confidence, the size bucket and a breakdown
  - ranked among **full-history** assets (both momentum legs); a one-leg asset is "insufficient history": scored and placed against that distribution, but no grade, tercile or tag (revised after the dry run, see below)
  - and, for the whole run, the size check, counts and output-shape warnings
- **Config** (`config.ts`):
  - `scoring` (cutoffs, cap, legs, regime modifiers all 0, size buckets, the 60% threshold, `validated: false`)
  - `scopeOverrides`: NEAR, SOL, SUI, AVAX, APT, decided by the scope rule in SPEC
  - `validateConfig` now rejects a non-zero regime modifier that has no `evidence_ref`
- **`metrics.ts`**: a scope override wins over the category mapping, so an overridden asset becomes `out_of_scope` and unrated.
- **`derive.ts`**: `computeRunScores` runs after metrics and regime, isolated. It is skipped with `scores_error` if metrics failed, and gets a null regime label if the regime step failed. It replaces the run's score rows wholesale (a config change can change the rated set, and an upsert would leave a stale row behind).
- **Archive**: `scripts/screener-archive.ts --table scores` (90 days, like metrics). The metrics archiver was generalized into one per-run archiver used by both tables, not copied.
- **Schema**: `screener_asset_scores` in `db/schema.sql`. The preflight (`check-screener-schema.mjs`) currently fails on it by design until the DDL is run. The preflight's column regex didn't recognize `smallint`, so it would have skipped `rules_evaluable` and `momentum_tercile`; that's fixed (125 → 127 declared columns).
- **Diagnostics** moved into `scripts/diag/` (committed, read-only unless noted):
  - `screener-run-report.mjs`
  - `screener-rated-diff.mjs`
  - `screener-config-diff.mjs`
  - `screener-l1l2-rated.mjs`
  - `screener-score-preview.ts`
  - `screener-score-verify.mjs`
  - `screener-score-run.ts` (writes derived score rows only)
  - `screener-live-run.ts` (writes a real live run with the local code)

## What I verified

- **Tests:** 272 pass. tsc and lint are clean (lint's warnings are all in older files). Schema preflight: 9 tables, 127 declared columns, all present live.
- **Live run `c9161e62`** (2026-09-23 ~15:5x UTC): a real snapshot plus every derivation step, run with the local code through the same two functions the cron calls. `trigger: unknown`, status `ok`, no `*_error` keys.
  - Snapshot 11.6 s; derivations 46.8 s (history read 20.5 s, BTC reference 17.2 s, scores 0.4 s to write). CoinGecko's primary key hit its monthly cap and failed over to the backup key as designed.
  - **72 rated. 69 full history, 3 insufficient history (STONK, PONS, INDEX), 0 unscored.**
  - **Tiers:** pass 71, caution 0, high_risk 1 (BNKR).
  - **Tags:** LEADER 24, NEUTRAL 22, WATCH 23, and 3 untagged (the insufficient-history assets).
  - **Grades:** A 14, B 14, C 13, D 14, F 14.
  - **Size check:** top tercile is 8 small / 11 mid / 5 large; mid holds 46%, so not flagged. **Warnings:** none. **Plausibility warnings:** none.
  - **Scope:** NEAR, SOL, SUI, AVAX and APT are `out_of_scope` and unrated; HYPE, ARB and OP stay rated.
  - **Consistency check** (`screener-score-verify.mjs`): **72/72 rows match, 0 mismatches.** **Don't over-read this; it is only partly independent.** The script is plain JS with no import of our scoring code or config, and it computes percentiles by a different method (tie-averaged ranks, rescaled). That does catch arithmetic and wiring bugs, such as a wrong percentile, a wrong cutoff, or a row stored against the wrong asset. But I updated the verifier this session, right after rewriting `scores.ts`, and its **population and placement rules were mirrored from the implementation, not written from SPEC**. That covers: ranking among full-history assets only; placing a one-leg asset's leg, score and percentile against that set (mid-rank as one more member); and nulling grade, tercile and tag for one-leg assets. Where those rules were written down at all, SPEC's text was written in the same pass. The tier thresholds, grade cutoffs and tag grid were typed in from the decisions, but also by me, the same author. So a *misreading of the rules* would be shared by both sides and would not show up as a mismatch. A truly independent check would need someone other than the implementer to write the verifier from SPEC alone.
- The earlier dry run on `8798244f` is superseded by this live run.

**Insufficient history per run:** 3 on `c9161e62` (4 in the dry run on `8798244f`). Each run records it in `notes.derivations.scores.counts.insufficient_history`. The top of the graded list is now DRV, RHEA, RAY, BTW, ARB. STONK still shows a 0.993 percentile, but it sits in its own section with no grade or tag.

## Rated assets with a CoinGecko L1/L2 tag, for review (nothing excluded automatically)

From `scripts/diag/screener-l1l2-rated.mjs` on run `8798244f` (2 CoinGecko calls; 372 coins tagged layer-1/layer-2 down to the $10M floor):

| Asset | Tag | DefiLlama category → bucket | Rev. (ann.) | My read |
|---|---|---|---|---|
| HYPE | L1 | Derivatives → perps_dex | $737.0M | **Keep.** The chain *is* the exchange; the revenue is the token's. |
| ARB | L2 | Foundation → other | $38.3M | Judgment call. Sequencer revenue accrues to the DAO, so it's arguably the L2's own business. |
| SOL | L1 | Canonical Bridge → oracles_infra | $32.8M | **Same error as NEAR.** An L1 valued on its bridge's revenue. |
| NEAR | L1 | Bridge → oracles_infra | $18.4M | Already overridden (out_of_scope from the next run). |
| DRV | L2 | Options → perps_dex | $6.2M | **Keep.** An app-chain whose revenue is the app's. |
| OP | L2 | Services → oracles_infra | $5.4M | Judgment call, same as ARB. |
| RUNE | L1 | Dexs → perps_dex | $4.3M | **Keep.** The chain is the DEX. |
| DYDX | L1 | Derivatives → perps_dex | $3.0M | **Keep.** The chain is the exchange. |
| SUI | L1 | Canonical Bridge → oracles_infra | $2.7M | **Same error as NEAR.** |
| AVAX | L1 | Canonical Bridge → oracles_infra | $2.0M | **Same error as NEAR.** |
| APT | L1 | Canonical Bridge → oracles_infra | $1.2M | **Same error as NEAR.** |

**Decided 2026-09-23, by rule (SPEC, "Scope rule"):** does the revenue represent the token's own core business, or an app/bridge filed under the chain?
- **Out:** NEAR, plus SOL, SUI, AVAX and APT (canonical-bridge revenue against the whole chain's market cap).
- **In:** HYPE, DRV, RUNE and DYDX (the protocol is the business), ARB and OP (sequencer revenue is the chain's own business; whether holders capture it is a value-capture question, not scope).

This table stays here as the review record. Re-run the diagnostic to catch the next case.

## What surprised me

- **One-leg scores clustered at the extremes, and that was a design flaw, not noise.** Averaging two percentile ranks compresses variance, so a one-leg score keeps the full 0–1 range and lands at the extremes by construction. The dry run put STONK at #1 on a single +1118% `mom_3w` leg. **Fixed (decided 2026-09-23):** one-leg assets are "insufficient history". They get a score and a placed percentile, but no grade, tercile or tag, and they're excluded from the ranking population so they can't move anyone else's rank. A test pins that. I also left the grade null, which goes one step past the literal decision (no tercile, no tag). The grade is the same percentile cut into bands, so it would have carried the same artifact (STONK: "A").
- **Four more L1s had the NEAR problem**, and nobody would have noticed without the diagnostic. SOL, SUI, AVAX and APT were all in the middle or top tercile on bridge revenue.
- **A preflight blind spot:** `check-screener-schema.mjs` didn't recognize `smallint`, so two of the new columns would have gone unchecked. It's fixed, and the declared count went from 125 to 127.

## Open items

- **3b (the UI):** show insufficient-history assets in their own section, and pick one run per UTC day explicitly (BACKLOG).
- Carried over: measured dilution (~2026-12-21), unlock data (deferred), regime thresholds (~2026-10-20), stablecoin source switch (~2026-10-22).

---

## 3b — the screener page

### What I built
- **`/screener` is now the real screener.** The Phase 1 raw spot-check table moved to `/screener/universe`, and each page links to the other. Both stay out of the sidebar.
  - **Banner (always shown):** "Unvalidated screen: grades are not yet backtested."
  - **Run caption:** date, staleness, scheduled or manual, rated and unrated counts.
  - **Regime panel:** the label, every rule's outcome (fired, no, or not evaluable), every input with "—" when missing, and "k of 4 rules · k of 7 inputs". It says plainly that a NEUTRAL built on missing inputs reflects missing history, and that the regime modifiers are 0.
  - **Ranked table** (69 on the latest run), sortable and persisted (`cryptoport:screenerScoresSort`):
    - rank (fixed by percentile, whatever the sort; ties share a rank), asset, setup tag, grade with "(raw X)" when High risk capped it, percentile, both momentum legs
    - risk tier with "k/4" rules evaluable (hover shows the fired rules), confidence, sector, market cap
    - a conflict ⚠ on the asset, as in the universe table
  - **The caption says what "Pass" means today:** only the revenue-drop rule can be evaluated, so Pass mostly means "nothing we can check fired". The size-check warning appears only when the check fires.
  - **Insufficient history, a separate panel:** "Placed at" instead of "Percentile", **no rank column**, no grade or tag, and a caption explaining why.
  - **Unrated (610):** fail counts per kill filter.
- **`runSelection.ts`** (pure, 4 tests): `pickRunPerUtcDay` / `latestDailyRun`, implementing SPEC's "One run per UTC day" (the day's latest `ok` live run). Both `/screener` and `/screener/universe` use it; Phase 4 must too.
- **If the chosen run has no scores**, the page states why: still computing (about a minute after the snapshot), a scoring failure (with the recorded error), or a metrics failure. It **never falls back to an earlier run**.

### What I verified
- tsc and lint are clean, all 276 tests pass, and the schema preflight is OK.
- **Rendered against the real database** (local dev server on port 3100; `/screener` returned 200 in about 0.7s warm; `/screener/universe` returned 200):
  - It picks run `c9161e62` (today's latest ok run).
  - Ranked 69: DRV, RHEA, RAY, BTW, ARB at the top.
  - BNKR shows as High risk, grade C, NEUTRAL.
  - Insufficient history: STONK placed at 99, PONS 85, INDEX 1, none ranked.
  - The regime panel shows 2 of 4 rules and 4 of 7 inputs.
- **Desktop layout checked in a browser.** **Phone width was not checked visually**: the browser window wouldn't resize. The table follows the app's mobile conventions (`overflow-x-auto`, secondary columns hidden below `sm`), but nobody has looked at it at 390px yet.

### Open items
- Phone-width visual check (above).
- A sector filter / per-bucket view: not built. Percentiles are across all rated assets by decision, so a filter would only hide rows, and nothing asked for it yet.

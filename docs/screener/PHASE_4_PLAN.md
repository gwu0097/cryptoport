# Phase 4 plan: backtest harness

Proposed and **approved 2026-09-23**, all four recommendations as proposed, plus three requirements from sign-off (A, B, C below). What was built and found goes in `PHASE_4.md`. This file is the agreed scope, and the **definitions section is the specification the independent verifier is written from**.

Split like Phases 2–3: **4a** = the point-in-time panel, deep data and coverage (data only, no conclusions); **4b** = the tests, the independent check, and the report. Sign-off between them.

## What the data can support, stated before anything runs
- Nearly all history is **backfilled**: 2025-09-22 → 2026-09-21, one daily reading per asset, for the 682 assets that exist today. Live history: 2 days.
- `mom_12w` needs 84 days of history, so the first scorable formation date is about 2025-12-15. A 30-day forward return must end by 2026-09-21, so the last formation date is 2026-08-22.
- That gives **~9 independent 30-day periods × ~70 rated assets** (primary) and **~3 independent 90-day periods** (descriptive only).
- **Requirement A (sign-off):** the expected outcome is written into `PHASE_4.md` **before** any test is run. With this little data, the honest result is most likely "inconclusive" for every factor. Recording the prediction first makes a marginal result harder to rationalize afterwards. The prediction is also stored in the backtest run's DB row at insert time, before its results exist.

## Non-negotiable
- **The backtest never gets its own scoring implementation** (sign-off; also in SPEC). At every formation date it scores through the production path: `metrics.ts` `computeAssetMetrics`, `history.ts` `computeHistoryMetrics`, `scores.ts` `scoreRun`, with `config.ts`. A separate implementation would validate code we don't run.
- **Point-in-time:** at formation date D, only readings observed on or before D.
- **One reading per asset per day** by the shared rule (`history.ts` `dailyReadings`: a complete reading beats a degraded one, then the latest wins). Days whose representative live run is degraded are excluded (`runSelection.ts`). None fall in the 1-year window.
- **Zero CoinGecko calls** in all of Phase 4. The deep data is DefiLlama only.
- **Requirement C (sign-off): a factor goes active only if it survives the held-back third.** This isn't relaxed, however strong it looks in-sample; with this little data, in-sample strength is close to meaningless.

## Decisions (accepted 2026-09-23)
1. **Survivorship: measure it and report it as a bound**, rather than reconstructing dead tokens. Without their historical market cap, "would it have been rated?" can't be answered. Count the DefiLlama protocols whose revenue cleared the $1M annualized floor at some point in the window but that have no CoinGecko-matched asset today, and report that count next to every result as the survivorship exposure.
2. **The deep-price Parquet is built now** (4a): DefiLlama prices on one fixed 00:00 UTC grid for every known asset **plus bitcoin in the same batches** (same-moment BTC pairing; the beta-bug lesson), covering 3 years plus a 120-day lookback. Plus each asset's daily revenue history (summed across its contributing slugs, the live job's membership) for the 2- and 3-year revenue-floor universe. Stored locally under `~/cryptoport-archive/screener/`, verified by read-back.
3. **Results table `screener_backtest_runs`**: one row per backtest execution, written with its `prediction` and `status = 'running'` **before** the tests run, then updated with the results. It gives a candidate factor's `evidence_ref` a stable id (`screener_backtest_runs:<id>`).
4. **Monthly non-overlapping periods, 30-day forward returns primary, 90-day descriptive.** Overlapping daily windows were rejected: hundreds of points that look like evidence without adding independent information.

## Definitions (the verifier's specification)
- **Formation dates (30-day, primary):** D_last = the last data date − 30 days. Going back in steps of exactly 30 days, D_last, D_last − 30, …, while D ≥ the first date on which at least 30 rated assets have both momentum legs. For the 1-year window: data through 2026-09-21, so D_last = 2026-08-22.
- **Formation dates (90-day, descriptive):** the same construction with a step of 90 days and D_last = the last data date − 90 days.
- **The asset's reading on day X:** its reading for UTC date X (a backfilled row is one per date). A missing reading on D or D+h means the asset is excluded from that period. Nothing is interpolated or taken from a nearby day.
- **Forward return vs BTC**, horizon h ∈ {30, 90}: `fwd_btc = (P_i(D+h) / P_i(D)) / (P_BTC(D+h) / P_BTC(D)) − 1`. The BTC price is from the same backfill grid as the asset's, the same pairing rule as `history.ts`. This is the same ratio form as `mom_3w` / `mom_12w`.
- **Forward return vs the equal-weight basket (secondary):** `r_i = P_i(D+h)/P_i(D) − 1`, and `fwd_ew = r_i − mean(r_j over the period's rated assets j with both prices)`.
- **Population per period:** the assets **rated** at D (all kill filters evaluated at D with the current config). Each factor is tested on the rated assets where both the factor value and the forward return are non-null.
- **Factor direction:** higher = predicted better. Score B, `mom_3w`, `mom_12w`: as is. `beta_btc`: as is (reported, no expected sign). **Valuation candidates are tested as "cheapness"**: `−ps_circ` and `−pf_circ` (market cap ÷ annualized revenue or fees; FDV-based ratios can't be tested because backfilled rows have no FDV). `−dilution_rate_implied` is labeled a proxy: measured dilution doesn't exist historically. `buyback_yield` is listed as untestable, since only 6 assets have a documented mechanism.
- **Rank IC (per period):** the Spearman rank correlation between factor value and `fwd_btc` across the period's population, with **ties given the average of their ranks**, computed as the Pearson correlation of the two rank vectors. A period with fewer than 10 assets in the population is skipped and counted.
- **IC summary:** over the n periods with an IC: mean, sample standard deviation s, `t = mean / (s / √n)`, and a 95% CI of `mean ± t_{0.975, n−1} · s / √n`.
- **Tercile spread (per period):** rank the population by factor value (ties: average rank). Top tercile = ranks in the top ⌈n/3⌉ and bottom tercile = the bottom ⌈n/3⌉ positions after sorting descending, ties broken by gecko_id ascending. Spread = mean `fwd_btc` of the top tercile − mean of the bottom tercile. Summary: mean, t and CI as for IC.
- **Setup-tag test:** per period, mean `fwd_btc` by tag. The key comparison is LEADER ∪ WATCH (Pass tier) minus SPECULATIVE. With ~1 High-risk asset per period this is expected to be untestable, and will be reported as such.
- **Controls:** per period, regress the factor's rank on the ranks of size (`size_log_mcap`) and Score B (OLS with intercept). The **residual IC** is the Spearman IC of the residual vs `fwd_btc`, summarized the same way. For Score B itself, the control is size only.
- **Held-back third (C):** with the formation dates in time order, the **last ⌈n/3⌉ periods** are the holdout; the rest are the training set. A candidate factor may go active only if (i) its training mean IC and holdout mean IC have the same sign, **and** (ii) the holdout 95% CI excludes 0. With about 3 holdout periods, (ii) is nearly unreachable, and that's intended.
- **Windows:** 1-year (primary; backfilled, full rated universe and every factor). 2- and 3-year (robustness, **momentum factors only**, on a different, labeled universe: assets with a deep price at D and a trailing 30-day DefiLlama revenue ≥ the $1M annualized floor at D; no market cap or volume gates exist that far back). Each window reports its own periods, per-period asset counts, and coverage. **If results flip between windows, report the flip; never average across windows.**
- **Backfilled vs live:** every period in these windows is backfilled. Live-snapshot periods don't exist yet (2 days). That's reported, not blended.

**Clarifications after 4b** (terciles are positional; the deep windows also stop at their window start; BTC is paired at each reading's own moment; the holdout's n = periods with an IC): see `PHASE_4.md`, 4b "Independent check". The text above is exactly what the independent verifier worked from.

## Requirement B: the independent check (sign-off)
3a's lesson: its verifier mirrored the implementation's rules, so it was a consistency check, not an independent one. **Plan:** in 4b, the verifier is written by a **separate agent with a fresh context**. It gets only this definitions section and the exported panel (CSV), never `src/`, `scripts/` or my implementation. It writes plain Python, with no dependencies, since DuckDB and pyarrow aren't installed. It recomputes IC and tercile spreads for every factor and period, and its numbers are compared with mine. What that does and doesn't buy, stated plainly: the verifier's author hasn't seen my code, so a misreading on my side won't be copied, and **an ambiguity in this text** will surface as a mismatch rather than a shared silent choice. It is still the same underlying model. If that separation turns out not to be practical, the result is labeled a consistency check, as in 3a.

## Deliverables
- **4a:**
  - the deep-price and deep-revenue Parquet files (read-back verified)
  - the point-in-time panel for every window (formation date × asset: factor values, rated status, forward returns), exported as Parquet and CSV
  - the coverage table and survivorship bound
  - `PHASE_4.md` with the **prediction written first**
  - the `screener_backtest_runs` table (SQL handed over first)
- **4b:**
  - the tests
  - the independent check
  - `PHASE_4.md` results and a recommendation: keep equal weights, adjust with evidence, or drop a component
  - Then stop.

## Out of scope
Removing the "Unvalidated" banner (the user's call after reading the results), a "model health" page, and anything in Phase 5.

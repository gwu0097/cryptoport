# Phase 4 — backtest

Scope, decisions and the exact metric definitions: `PHASE_4_PLAN.md`.

## Prediction — written 2026-09-23, BEFORE any panel was built or any test run (requirement A)

Recorded first so a marginal result can't be rationalized afterwards. It will also be stored verbatim in the backtest run's `screener_backtest_runs.prediction` at insert time, before its results exist.

**Expected outcome: "inconclusive" for every factor, in every window.**

- **Why:** ~9 independent 30-day periods × ~70 rated assets (1-year window); ~3 independent 90-day periods.
  - With n ≈ 9 periods, a mean rank IC needs to be roughly ≥ 0.10 with very consistent sign across periods to reach t ≈ 2.
  - Even then, the held-back third is ~3 periods, and requirement C (the holdout 95% CI must exclude 0) is nearly unreachable with 3 points.
- **Specific expectations,** so the report can say whether each was right:
  1. **Score B, `mom_3w`, `mom_12w`:** mean IC within ±0.10, 95% CI spanning 0. The sign can flip between the 1-year and the 2/3-year windows. Crypto cross-sectional momentum is regime-dependent, and 2023–2026 contains more than one regime.
  2. **Valuation cheapness** (`−ps_circ`, `−pf_circ`): mean IC near 0, CI spanning 0. No prior reason for a 30-day horizon to reward cheapness.
  3. **`−dilution_rate_implied` (proxy):** inconclusive; noisy (market cap ÷ price).
  4. **`beta_btc`:** the IC mostly reflects BTC's own direction per period, so its sign follows the market, not skill. Reported without an expected sign.
  5. **Setup tags:** untestable as designed. Almost everything is Pass (~1 High-risk asset per period), so there's no SPECULATIVE group of any size to compare with LEADER/WATCH.
  6. **Controls:** any raw IC shrinks toward 0 after controlling for size and Score B.
  7. **Survivorship:** the bound will be material: dozens of protocols that earned ≥ $1M/yr of revenue but have no CoinGecko-matched token today. The 1-year results are on survivors only and biased by an unknown amount.
- **What would surprise me:** a factor whose training and holdout ICs share a sign **and** whose holdout CI excludes 0. With 3 holdout periods, that would itself deserve suspicion before belief.
- **Consequence if the prediction holds:** keep equal weights, activate nothing, keep the "Unvalidated" banner, and re-run as live history accumulates. The report will say exactly that, rather than stretch a result.

---

## 4a — deep data, point-in-time panel, coverage

*(Nothing below this line existed when the prediction above was written.)*

### Deep-history store (for the 2- and 3-year windows)
- **Contents:** DefiLlama prices on one 00:00 UTC grid, 2023-05-27 → 2026-09-22 (1,215 days). **673 of 682 coins priced** (526,018 rows; bitcoin complete). Daily revenue for **639 assets** (468,759 rows), summed across each asset's contributing slugs by the live job's own membership.
- **Cost:** 1,671 `/chart` calls + 995 `/summary/fees` calls, **0 CoinGecko calls**, 55 minutes. Stored in `~/cryptoport-archive/screener/deep/` with `manifest.json` and content hashes.
- **Spot-checked against different sources (SPEC required step):**
  - **Prices:** 24/24 random (coin, date) points match `/prices/historical` at 00:00 **exactly**.
  - **Revenue:** exact against DefiLlama's own **parent-protocol** pages (its own cross-child sums) for Uniswap, Hyperliquid, GMX and Aave, 3 random dates each.
  - **Gaps:** 488 coins have gaps (20,509 missing coin-days; median 5 per coin with gaps). They're spread evenly over the 25-day call cycle, so they're not a chaining artifact. Missing dates checked against `/prices/historical` return nothing, or a point hours away: **real DefiLlama gaps**. The definitions already exclude an asset from a period when D or D+h is missing (no nearby-day substitution).
- **A bug found and fixed on the way:** the `/chart` grid-date bug (SPEC). The store failed the spot-check on its first build (bitcoin 1,024 of 1,215 days, shifted days 2–10% off), even though its own read-back check passed.

### Moments verified before building the 1-year panel (SPEC required step: labels vs real timestamps)
Using the verified 00:00 deep prices as the reference:
- **CoinGecko-fallback prices** in backfilled rows are CoinGecko's 00:00 point of their labeled date. Median difference from the 00:00 price: 0.24% on the same date, against 2.0–2.4% for the dates either side. They're correctly dated, and after the grid-date fix they pair with the right BTC. **No stored row needs recomputing.**
- **Market caps in backfilled rows are also CoinGecko's 00:00 point**, while a DefiLlama-priced row's price is from the backfill run's ~21:31 grid. Evidence: market cap ÷ the 00:00 price gives a flat implied supply (median day-over-day change **0.000%**); market cap ÷ the stored price has **0.65%** daily noise.
  - **Unaffected:** momentum, beta and forward returns. Each is a price over a same-moment BTC price, at each endpoint.
  - **Affected:** implied dilution (market cap ÷ price).
  - **Fixed for the backtest:** readings can carry `price_at_mcap_moment`. The 1-year panel supplies the verified 00:00 deep price, or null (never the mixed value).
  - **Production is unchanged:** there, `dilution_rate_implied` is display only (BACKLOG).
- **Backfilled rows' `observed_at` is a nominal 12:00 label**, not the moment of any value in the row: the price is at the run's grid (~21:31), the market cap at 00:00. The panel pairs by the run's grid, as production does. Found by the panel spot-check below, whose first attempt used `observed_at` and disagreed.

### Point-in-time panels
Built by `scripts/screener-backtest-panel.ts --window 1y|2y|3y` through the production scoring path. Files in `~/cryptoport-archive/screener/backtest/`: `panel_<w>.parquet` and `.csv` (raw prices at D, D+30 and D+90 included, so the verifier can recompute returns), plus `coverage_<w>.json`.

| Window | Population | 30-day periods | 90-day periods | Tested assets per period | Rows |
|---|---|---|---|---|---|
| **1 year (primary)** | production "rated" (all kill filters) | **9** (2025-12-25 → 2026-08-22) | 3 | 57–79 (median 62) | 5,869 |
| 2 years | labeled "deep" (price + trailing-30d revenue ≥ $1M/yr + in scope) | 24 (2024-10-02 → 2026-08-23) | 8 | 84–170 (median 128) | 12,373 |
| 3 years | labeled "deep" | 36 (2023-10-08 → 2026-08-23) | 12 | 40–170 (median 118) | 16,248 |

**1-year detail** (per formation date):

| D | Universe | Rated | Both momentum legs | With 30d fwd | With 90d fwd | High risk | LEADER / NEUTRAL / WATCH / SPECULATIVE / AVOID |
|---|---|---|---|---|---|---|---|
| 2025-12-25 | 642 | 74 | 70 | 74 | 74 | 0 | 23 / 24 / 23 / 0 / 0 |
| 2026-01-24 | 642 | 79 | 75 | 79 | 79 | 0 | 25 / 25 / 25 / 0 / 0 |
| 2026-02-23 | 646 | 62 | 58 | 62 | 62 | 17 | 13 / 20 / 12 / 6 / 7 |
| 2026-03-25 | 650 | 58 | 55 | 58 | 58 | 13 | 15 / 19 / 13 / 3 / 5 |
| 2026-04-24 | 647 | 60 | 56 | 60 | 60 | 15 | 14 / 18 / 16 / 5 / 3 |
| 2026-05-24 | 657 | 62 | 59 | 62 | 62 | 17 | 17 / 22 / 13 / 2 / 5 |
| 2026-06-23 | 657 | 57 | 55 | 57 | 57 | 12 | 14 / 19 / 14 / 4 / 4 |
| 2026-07-23 | 663 | 59 | 57 | 59 | — | 12 | 14 / 19 / 15 / 5 / 4 |
| 2026-08-22 | 665 | 62 | 57 | 62 | — | 4 | 18 / 19 / 17 / 1 / 2 |

- Every rated asset has a 30-day forward return on every date.
- **No rated asset is priced by the CoinGecko fallback on any formation date.**
- The walk stopped at 2025-11-25 (fewer than 30 rated assets with both legs).
- **The High-risk tier is evaluable from February on** (the revenue-drop rule needs 180 days of history), and it fires for 12–17 assets per period, more than today's 1. So SPECULATIVE is 1–6 per period and AVOID 2–7. The tag test will have small groups, not empty ones. (Prediction 5 said "untestable"; see "How the prediction is holding up".)

**Panel spot-check against a different source (SPEC required step):** `mom_3w` and `fwd30_btc` recomputed from `/prices/historical` at each reading's **real** moment, with no use of our history or pairing code: **8/8 rows exact** (4 in the 1-year panel at the backfill run's grid moment, 4 in the 3-year panel at 00:00).

### Survivorship bound (decision 1)
Dead-token protocols (a resolved token that CoinGecko no longer has market data for) whose trailing-30-day DefiLlama revenue cleared the $1M annualized floor **on at least one of the window's formation dates**. 149 checked, 177 DefiLlama calls. File: `survivorship_by_window.json`.

| Window | Dead-token protocols that would have qualified | Missing asset-periods | Share of the would-be population absent |
|---|---|---|---|
| 1 year | **1** (malinka) | 5 | **0.9%** |
| 2 years | **18** | 99 | **3.1%** |
| 3 years | **22** (e.g. Vertex 20 dates, Looter 18, Equalizer 15, HMX 13, KTX 13) | 155 | **3.8%** |

- **Direction:** a lower bound on what's missing, because protocols DefiLlama no longer lists at all are invisible.
- **Caveat for the 1-year row:** it's also looser than the rated filter. The dead tokens are counted on the revenue floor alone, and the rated set also needs market cap and volume.
- **Separately:** 135 protocols with ≥ $1M trailing-year revenue have **no token at all**. That's not survivorship (there was nothing to hold).

### How the prediction is holding up (before any test)
Nothing in this section is a test result. It's only what the coverage already shows.
- **Prediction 7 was wrong for the 1-year window:** I expected dozens of missing protocols, and the bound is 1 (0.9%). For 2 and 3 years it's 18–22 (3.1–3.8%), closer to what I expected.
- **Prediction 5 ("setup tags untestable") is weaker than I said:** historically 12–17 assets per period were High risk, so SPECULATIVE and AVOID exist, just small (1–7 per period). That comparison will be reported with its group sizes.
- **The 2- and 3-year windows have far more independent periods than the ~9 I cited** (24 and 36), though for momentum only and on a different universe. That makes a conclusive momentum result in those windows more plausible than the prediction's framing suggested. The prediction itself stays as written.

**4a stopped here** (signed off 2026-09-23). No IC, spread or tag test had been run.

---

## 4b — tests, independent check, results

**Run `d7cf95ae-a825-4eb0-98e5-821ba41e766e`** (`screener_backtest_runs`). The row was inserted at 2026-09-23 18:24:53 UTC with the prediction above, verbatim, and status `running`, **before** any number was computed. Code `1fcdcbb` (the runner refuses uncommitted code). Results: `~/cryptoport-archive/screener/backtest/results_d7cf95ae….json` and the row's `results` column.

**Each window is separate evidence and is never pooled** (sign-off, 4b). One correction, from the verifier: **the 2-year window is not independent of the 3-year window.** Its 24 periods are the last 24 of the 3-year window's 36, on the same deep universe (the rows are byte-identical). So there are **two** bodies of evidence here, not three: the 1-year rated universe, and the deep universe at two lengths.
- **1 year** = the production rated universe, every factor.
- **2 and 3 years** = a **different universe**: revenue floor only, no market cap or volume gates. It's a different population, with a 3.1–3.8% survivorship bound against 0.9%, and it tests momentum factors only.
- **A factor validated only on the deep windows would be validated on a universe the screener doesn't rate.** It earns production weight only if it also survives in the 1-year window, or if we explicitly accept and document weighting on evidence from a different population.

### Primary: 30-day forward return vs BTC — rank IC per window
Mean IC over the window's periods, t, 95% CI (t-based); tercile spread (top − bottom mean 30-day return vs BTC); held-back third (the last ⌈n/3⌉ periods) with the rule's outcome.

**1 year — production rated universe (9 periods, 55–79 assets each)**

| Factor | Mean IC | t | 95% CI | Tercile spread (t) | IC after controls (t) | Holdout: train / hold / hold CI | Passes |
|---|---|---|---|---|---|---|---|
| Score B | −0.024 | −0.73 | [−0.100, +0.052] | +0.093 (1.25) | −0.062 (−2.02) | −0.057 / +0.042 / [−0.35, +0.43] | **no** |
| mom_3w | −0.001 | −0.05 | [−0.057, +0.055] | +0.091 (1.65) | +0.018 (0.72) | −0.038 / +0.073 / [−0.12, +0.27] | **no** |
| mom_12w | −0.043 | −1.02 | [−0.141, +0.055] | +0.023 (0.45) | −0.037 (−1.18) | −0.064 / −0.002 / [−0.56, +0.56] | **no** |
| beta_btc (no expected sign) | **+0.157** | **4.06** | **[+0.068, +0.246]** | +0.051 (3.10) | +0.129 (3.52) | +0.122 / +0.226 / [−0.12, +0.57] | **no** |
| −ps_circ (cheapness) | −0.078 | −1.54 | [−0.196, +0.039] | −0.016 (−0.30) | −0.017 (−0.35) | −0.062 / −0.111 / [−0.35, +0.13] | **no** |
| −pf_circ (cheapness) | −0.065 | −1.66 | [−0.154, +0.025] | +0.006 (0.08) | −0.019 (−0.40) | −0.074 / −0.046 / [−0.34, +0.24] | **no** |
| −dilution_rate_implied (proxy) | −0.046 | −0.96 | [−0.158, +0.065] | +0.007 (0.20) | −0.046 (−0.85) | −0.069 / −0.002 / [−0.44, +0.44] | **no** |

*Controls: the factor's rank regressed on the ranks of size and Score B (Score B: size only); IC of the residual.*

**2 years — deep universe, momentum only (24 periods, 81–170 assets)**

| Factor | Mean IC | t | 95% CI | Tercile spread (t) | Holdout: train / hold / hold CI | Passes |
|---|---|---|---|---|---|---|
| Score B | −0.034 | −1.48 | [−0.083, +0.014] | −0.034 (−0.49) | −0.058 / +0.012 / [−0.036, +0.060] | **no** |
| mom_3w | −0.013 | −0.65 | [−0.056, +0.029] | −0.012 (−0.19) | −0.031 / +0.022 / [−0.027, +0.072] | **no** |
| mom_12w | −0.045 | −1.70 | [−0.099, +0.010] | −0.063 (−0.93) | −0.067 / +0.000 / [−0.100, +0.101] | **no** |
| beta_btc | −0.007 | −0.17 | [−0.092, +0.078] | +0.004 (0.06) | −0.050 / +0.081 / [−0.057, +0.218] | **no** |

**3 years — deep universe, momentum only (36 periods, 38–170 assets)**

| Factor | Mean IC | t | 95% CI | Tercile spread (t) | Holdout: train / hold / hold CI | Passes |
|---|---|---|---|---|---|---|
| Score B | **−0.051** | **−2.46** | **[−0.093, −0.009]** | −0.039 (−0.84) | −0.084 / +0.015 / [−0.039, +0.070] | **no** |
| mom_3w | −0.025 | −1.32 | [−0.063, +0.013] | −0.022 (−0.50) | −0.050 / +0.025 / [−0.031, +0.082] | **no** |
| mom_12w | **−0.053** | **−2.56** | **[−0.095, −0.011]** | −0.043 (−0.93) | −0.079 / −0.001 / [−0.072, +0.071] | **no** |
| beta_btc | −0.023 | −0.71 | [−0.088, +0.043] | −0.004 (−0.09) | −0.044 / +0.019 / [−0.108, +0.145] | **no** |

**No factor passes the held-back-third rule in any window.** Against the equal-weight basket (secondary), every IC is within ±0.002 of the vs-BTC figure, so it doesn't change any conclusion.

### Setup tags (1 year, 30-day)
LEADER ∪ WATCH (Pass tier) minus SPECULATIVE (Caution/High risk × top tercile), per period with a non-empty SPECULATIVE group (7 of 9; the group has 1–6 assets):
- **Mean +10.1 points** of 30-day return vs BTC; t = 2.64; 95% CI **[+0.7, +19.5]**.
- In-sample only; there is no holdout rule for tags. With SPECULATIVE groups of 1–6 assets, a couple of outliers could carry this.

### 90-day (descriptive only: 3 / 8 / 12 periods)
- **1-year window:** 3 points per factor. Every t-stat there (e.g. `mom_12w` t = 5.4, n = 3) is noise, not evidence.
- **2-year window:** every CI spans 0.
- **3-year window:** `mom_3w` −0.075 (CI [−0.122, −0.029]). It's negative, consistent with the 30-day reversal pattern.

### Independent check (requirement B)
A **separate agent with a fresh context** got only the plan's Definitions section, verbatim, and the three panel CSVs, never our code. It wrote its own stdlib Python. Its code and full ambiguity report are in `docs/screener/phase4b-independent-verifier/`.
- **404/404** (window × horizon × factor × period) rank-IC and tercile-spread cells equal ours within 1e-9. Every summary (mean, CI) and every holdout outcome also matches.
- It **recomputed every forward return from raw prices** (it didn't use our columns): **0 mismatches** in any window. Its t-quantiles match published tables.
- **What that establishes, and what it doesn't:** the verifier's author hadn't seen our code, so a misreading on our side wasn't copied, and the text's ambiguities came out as explicit choices. It is the same underlying model reading the same text. A misreading **of the text** that both sides made the same way would still pass. So this is stronger than 3a's consistency check, but not proof.

**Ambiguities it found** (the ones that could change a number; full list in `AMBIGUITIES.md`), and how we read each:
1. **Tercile membership when ties straddle the ⌈n/3⌉ boundary.** The text says both "ties: average rank" and "positions after sorting, ties by gecko_id". Those conflict. Both sides used the **positional** reading. The rank-threshold alternative only moves Score B (discrete values): 1y spread +0.0935 → +0.0936, 3y −0.0392 → −0.0361. **No sign change and no CI crosses 0.** Clarified below.
2. **Which BTC price is in `fwd_btc`.** It found within-date BTC differences of up to 4.8% in the 1-year panel and flagged it for checking. **Checked, and it's intended.** Each row pairs with BTC at its own reading's real moment:
   - The off-median rows on 2026-02-23 are 17 CoinGecko-fallback rows (all unrated) paired with **00:00 BTC ($67,641)**; BTC was **$64,545 at 21:32** (`/prices/historical`).
   - The other groups are different backfill runs' evening grids. Example: the 29 rated rows on 2026-05-24 whose BTC return differs from their peers' by ~0.8% (THORChain, Cetus, Velodrome, …) came from the backfill run on the **21:45** grid; their peers (Uniswap, Aave, …) from **21:32** (checked in the DB). So assets in one period are measured over 30-day windows about 13 minutes apart, each against BTC on its own grid. That's negligible, but true.
   - Under the alternative (one BTC per date), no conclusion changes. `mom_3w`'s 1y mean IC goes from −0.001 to +0.0004, a sign flip at essentially zero.
3. **The formation-date start rule for the 2- and 3-year windows.** Those windows started at the **window-length boundary** (last date − 730 / − 1095), which the Definitions text never states. Only the "≥ 30 rated with both legs" rule is written. It never bound in those windows (minimum 81 / 38). A spec gap, clarified below; no effect on results.
4. **The 2-year window is nested in the 3-year window** (same rows on the same dates). That's not independent evidence (corrected above).
5. **Grids differ by a day between windows.** 1y data ends 2026-09-21 (the backfill); 2y and 3y end 2026-09-22 (the deep store). So their formation dates are one day apart, not nested. Harmless (they're separate evidence anyway), but true, and now stated.
6. **"n" for the held-back third** could mean formation dates or periods with an IC. They're identical here (0 skipped periods in every window).

**Clarifications to the Definitions** (resolving the above for future runs; the text the verifier used stays as it was, in the evidence folder):
- Terciles are **positional**: sort by the (direction-adjusted) factor descending, ties by gecko_id ascending; top = the first ⌈n/3⌉ rows, bottom = the last ⌈n/3⌉. The "average rank" wording applies to IC only.
- The 2- and 3-year windows' formation dates also stop at the window start: last data date − 730 or − 1095 days.
- `fwd_btc` pairs each endpoint with BTC **at that reading's own real moment**, so BTC can differ between assets on the same date.
- The holdout's n = the number of periods with an IC.

### The prediction, scored (the original text above is unchanged)

| # | Predicted | Result | Verdict |
|---|---|---|---|
| headline | "Inconclusive" for every factor in every window; nothing activates | 0 of 15 (factor × window) pass the holdout rule | **Right** |
| 1 | Score B / momentum: mean IC within ±0.10, CI spanning 0 | 1y: yes. **3y: Score B −0.051 and mom_12w −0.053, CIs entirely below 0** (in-sample; both fail the holdout, since the holdout means are about 0) | **Partly wrong:** significant in-sample in the deep window, in the negative direction |
| 1 | Sign may flip between windows | beta +0.157 (1y) vs −0.02 (deep); Score B / mom_3w tercile spreads positive in 1y, negative in 2y/3y | **Right** |
| 2 | Cheapness near 0, CI spanning 0 | −0.078 / −0.065, CIs span 0 (if anything, expensive did better) | **Right** |
| 3 | Dilution proxy inconclusive | −0.046, CI spans 0 | **Right** |
| 4 | Beta follows the market, no skill | 1y +0.157 (t 4.1) in-sample, gone in the deep windows: regime-shaped | **Right** in spirit; it's significant in 1y |
| 5 | Setup tags untestable | Testable with small groups: LEADER ∪ WATCH − SPECULATIVE = +10.1 pts (CI [+0.7, +19.5]) in-sample | **Wrong** (already flagged after 4a) |
| 6 | Any IC shrinks toward 0 after controls | beta +0.157 → +0.129 (shrank); **Score B −0.024 → −0.062 (grew)** | **Mixed** |
| 7 | Survivorship "dozens" | 1 / 18 / 22 protocols (1y / 2y / 3y) | **Wrong for 1y** (flagged after 4a) |
| surprise | A holdout pass would itself deserve suspicion | No holdout pass anywhere | n/a |

### Recommendation
1. **Weights: keep every candidate factor at weight 0. Activate nothing.** No factor passes the held-back third in any window, which was the pre-registered bar (C). `evidence_ref` stays null everywhere. This run (`d7cf95ae`) is the evidence *against* activation.
2. **Score B, the screener's primary ranking, has no demonstrated predictive value, and some in-sample evidence runs the other way.**
   - On the production rated universe (1y), its IC is about 0.
   - On the deeper, looser universe (3y) it's **significantly negative in-sample** (momentum reversing). That doesn't hold in the holdout, and **it's a different universe from the one the screener rates**, so it doesn't justify flipping the sign either.
   - What it does mean: **the grades and LEADER / WATCH tags are a momentum ranking with no evidence behind it.** The "Unvalidated" banner must stay. If anything, it understates the situation.
   - Your call: whether `/screener` should also say plainly that the backtest found no predictive value for the momentum ranking (a one-line factual caption next to the banner). I haven't changed the page.
3. **Beta's 1-year result** (+0.157, t 4.1) is the largest in-sample effect in the run, but it has no expected sign, it vanishes in the deep windows, and it fails the holdout. Most likely it's this year's market direction (higher-beta names beat BTC in an up-drifting market), not a stable factor. **No action.**
4. **Setup tags:** the in-sample gap (Pass-tier top/bottom beat SPECULATIVE by +10 pts/30d) suggests the **High-risk tier's revenue-collapse rule identifies underperformers**. The tier is already a filter, not a weight. **No action now.** The tag result rests on 1–6 SPECULATIVE assets per period.
5. **Pre-register the next run's hypotheses now,** so they can't be fitted later. The next run should re-test on growing live history, with these as its written prediction:
   - (a) Score B's IC on the rated universe is ≤ 0 (the reversal direction);
   - (b) LEADER ∪ WATCH − SPECULATIVE > 0.
   - With ~1 more independent 30-day period per month of live data, the 1-year window's holdout gets meaningfully larger only after several months. The next useful re-run is not before ~2026-12. The measured-dilution rule also becomes evaluable then (~12-21).
6. **Nothing in production changes from this phase.** Weight > 0 needs your explicit approval after reading these numbers, and the evidence doesn't support it.

**4b stops here.**

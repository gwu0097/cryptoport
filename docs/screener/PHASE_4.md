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

**4a stops here. No IC, spread or tag test has been run.** 4b (tests, the fresh-context independent verifier, results, recommendation) waits for sign-off.

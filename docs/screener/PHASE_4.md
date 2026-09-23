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

*(In progress. Filled in as it's built; nothing below this line existed when the prediction above was written.)*

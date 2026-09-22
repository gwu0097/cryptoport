# Phase 2a — config, regime, kill filters, current metrics

Phase 2 was split: **2a** (this file) is everything computable from a single live snapshot; **2b** is the history-derived half (momentum, beta, revenue growth/collapse, dilution). 2b was going to wait on history, but the 365-day backfill finished before 2a started, so 2b follows directly.

## What I built

- **`src/lib/screener/config.ts`** — the single config file (principle #9): gates, tier thresholds (with the three 2026-09-22 fixes), the four weight-0 candidate factors, sector buckets, regime thresholds, and the six source-verified holder value-capture mechanisms. `validateConfig` enforces "no `active` factor without an `evidence_ref`" and "only active factors carry weight". Each distinct config is recorded once in `screener_scoring_config_versions` (SHA-256 of its canonical JSON), and every derived row points at it.
- **`metrics.ts`** (pure) — per-asset metrics and kill-filter gates from one snapshot. **`regime.ts`** (pure) — the market-regime label from three-valued rules.
- **`derive.ts`** — runs both after each live snapshot, in the same cron invocation, each isolated: a failure is recorded in the run's `notes.derivations` and never fails the snapshot. Each regime input source gets one retry (see "What surprised me").
- **New tables:** `screener_scoring_config_versions`, `screener_regime_snapshots` (one row per live run), `screener_asset_metrics` (primary key `(run_id, asset_id)`, no other index; 90-day retention via `scripts/screener-archive.ts --table metrics`, archive-then-delete). Plus a live-path duplicate guard: unique `(run_id, asset_id) where not is_backfilled`.
- **Regime input adapters:** CoinGecko `/global` (BTC dominance), DefiLlama stablecoins (USD-pegged supply now and a month ago), DefiLlama prices now and 28 days ago (BTC, ETH), Hyperliquid `metaAndAssetCtxs` (BTC/ETH funding and BTC open interest).
- **Two changes to the daily job:**
  - **Writes are batched** (500 rows per request). The job went from **173 s to 11.8 s** of its 300 s budget, which is what makes room for the derivation step in the same invocation.
  - **A grouped asset's sector is now its highest-revenue child's category**, not its first child's. Verified: Hyperliquid is now Derivatives (was Dexs), PUMP is Launchpad (was Dexs).

## What I verified

Run `d770c889` (a real live snapshot plus derivations, 2026-09-22 23:0x UTC): 682 assets; derivations took 14.6 s.

**Independent spot checks.** Recomputed from raw CoinGecko market data and DefiLlama's own *parent-protocol* pages, with none of our code involved:

| Asset | ps_circ (ours vs independent) | ps_fd | float | capture / buyback_yield |
|---|---|---|---|---|
| HYPE | 29.316 vs 29.397 (−0.28%) | −0.28% | 0.2224 = 0.2224 | 1.000 = 1.000 / 3.41% vs 3.40% |
| PUMP | 3.177 vs 3.174 (+0.11%) | +0.11% | 0.4670 = 0.4670 | 0.446 = 0.446 / 14.05% vs 14.07% |
| AAVE | 36.611 vs 36.657 (−0.12%) | −0.12% | 0.9643 = 0.9643 | 0.000 = 0.000 (paused; mechanism documented, so a real 0) |
| UNI | 32.703 vs 32.576 (+0.39%) | +0.39% | 0.6207 = 0.6207 | — (no documented mechanism → null) |

The ratio differences are price and revenue drift between the run and the check a few minutes later. Supply-based ratios match exactly. PUMP's 0.446 capture lines up with its documented 50% buyback.

**Stablecoin input vs a different DefiLlama endpoint** (the history chart instead of the snapshot): supply $312.1B vs $311.8B (0.1%). The 30-day change is **0.94% vs 1.15%**, because the two endpoints define "a month ago" differently. That straddles the ±1% "flat stablecoins" band, so BTC_LED's stablecoin condition can flip on data-source definitions alone. It's one more reason the regime thresholds are marked unvalidated.

Tests: 212 pass, including new ones for the metric formulas (null handling, the $1M floor, mechanism-gated capture), gates, config validation and hashing, regime rules and percentiles, and dominant-sector selection.

## Regime output (run `d770c889`)

**Label: NEUTRAL. Rule coverage: 1 of 4 rules evaluable; input coverage: 4 of 7 inputs available.** The NEUTRAL label comes from missing history, not from the market, and **shouldn't be read as a finding.**

| Input | Value | Available? |
|---|---|---|
| BTC dominance | 58.72% | yes |
| BTC dominance 4-week change | — | **no** — no free history; built from our own rows. First possible **~2026-10-17 to 10-20** (28 days ± 3-day tolerance) |
| ETH/BTC 4-week change | +2.84% | yes |
| Stablecoin supply 30-day change | +0.94% ($312.1B) | yes |
| Funding percentile vs stored history | — (avg hourly funding today 0.0000178) | **no** — needs 30 stored points, ~**2026-10-22** |
| BTC open interest 4-week change | — ($3.99B today) | **no** — built from our own rows, same dates as dominance |
| BTC price 4-week change | +9.19% | yes |

| Rule | Outcome | Why |
|---|---|---|
| FROTH | not evaluable | funding percentile and OI change both missing |
| RISK_OFF | **false** | stablecoin supply is growing (+0.94%), so the "shrinking" condition fails regardless of dominance |
| ROTATION | not evaluable | needs the dominance 4-week change |
| BTC_LED | not evaluable | dominance > 58% ✓, stablecoins flat ✓, but needs the dominance 4-week change |

**Until ~2026-10-20 the label can only be NEUTRAL** (or FROTH, if OI builds faster than expected). From then on, at ~58–59% dominance, **BTC_LED will fire most days**. If the label doesn't vary over the first month with full inputs, the thresholds need revising, not the label trusting (recorded in `config.regime.validated: false` and SPEC). Note also that the funding history counts stored *rows*, not days. Extra manual runs (like this one) add rows, so a few days of double-counting are possible early on.

## Kill filters (run `d770c889`, 682 assets)

A gate whose input is null is `not_evaluable` and doesn't fail (absence of data isn't evidence).

| Gate | Pass | Fail | Not evaluable | Unrated by this gate alone |
|---|---|---|---|---|
| Core data (price, market cap, revenue present) | 588 | 94 | 0 | 8 |
| Out of scope (Chain, Meme) | 655 | 27 | 0 | 4 (TRX, MON, CC, SHROOM) |
| Market cap ≥ $10M | 242 | 429 | 11 | 0 |
| 24h volume ≥ $2M | 187 | 484 | 11 | 25 |
| Annualized revenue ≥ **$1M** | 133 | 463 | 86 | 68 |
| Unlock overhang | 0 | 0 | 682 | — (no forward unlock data) |
| Collapsing revenue | 0 | 0 | 682 | — (Phase 2b) |

**Rated: 79.** The earlier "85 at $1M" was a quick three-gate count on the 21:24 run. On this run the same count is 83 (the market moved in between), and the full gate set also excludes 4 out-of-scope assets. No asset is rated that the quick count excluded.

**By bucket:** perps_dex 24, oracles_infra 14, other 14, launchpad_trading_apps 11, lending 8, liquid_staking 4, yield 4.

**79 is still thin, and that's expected, not a failure.** Terciles are ~26 assets each. Only five buckets reach the 4-per-sector minimum with room to spare. A Phase 4 backtest on one year with ~80 names will most likely come out *inconclusive*, and it should be reported that way rather than stretched. The next lever is universe size (past ~100 rated, revisit the sector buckets, e.g. Prediction Market in perps_dex).

## Sample metrics (top 12 rated by annualized revenue)

| Asset | Bucket | Rev (ann.) | P/S circ | P/S FD | P/F circ | Capture | Buyback yield | Float | MC/TVL |
|---|---|---|---|---|---|---|---|---|---|
| HYPE | perps_dex | $737.3M | 29.3 | 125.9 | 22.9 | 1.00 | 3.4% | 0.22 | — |
| PUMP | launchpad_trading_apps | $661.9M | 3.2 | 5.7 | 1.1 | 0.45 | 14.1% | 0.47 | — |
| PONS | launchpad_trading_apps | $304.1M | 1.6 | 1.6 | 0.3 | — | — | 0.68 | — |
| STONK | launchpad_trading_apps | $229.4M | 1.1 | 1.1 | 1.1 | — | — | 0.83 | — |
| UNI | perps_dex | $194.1M | 32.7 | 46.8 | 2.5 | — | — | 0.62 | — |
| AERO | perps_dex | $172.5M | 3.9 | 7.9 | 3.2 | — | — | 0.50 | — |
| SKY | lending | $163.9M | 9.9 | 9.9 | 4.9 | 0.33 | 3.3% | 1.00 | 0.28 |
| WLFI | lending | $136.7M | 13.6 | 42.7 | 13.6 | — | — | 0.32 | — |
| CARDS | other | $119.9M | 1.4 | 2.9 | 1.4 | — | — | 0.47 | — |
| CAKE | perps_dex | $89.9M | 9.0 | 9.4 | 2.9 | — | — | 0.80 | — |
| JUP | perps_dex | $87.0M | 11.6 | 23.9 | 4.2 | — | — | 0.33 | — |
| RAY | perps_dex | $69.1M | 7.0 | 14.5 | 1.2 | — | — | 0.49 | — |

All valuation ratios are **display-only (weight 0)** until Phase 4. "—" means null (unknown or not applicable), never 0.

## What surprised me

- **A one-off HTTP 400 from CoinGecko `/global`** cost the first run its BTC dominance reading. It didn't reproduce in the same call order, and a re-run filled it. It was handled as designed: the input was null, BTC_LED showed as not evaluable, and the error was recorded in provenance. But each missed day leaves a hole in the 28-day history that dominance and OI changes are built from, so each regime source now gets one retry after 5 s.
- **Two of the supplied holder-mechanism citations didn't support their numbers** (HYPE's ~99% and ENA's $7.5B). Better sources that do were found and cited. For AAVE, nothing confirms the pause in September, so its `as_of` is the last date with evidence (2026-06-25), not today. Recorded in SPEC.
- **The $1M revenue floor had never been recorded anywhere.** It's now in SPEC and config, dated 2026-09-22.

## Open items / carried into 2b

- **2b:**
  - momentum (3w/12w vs BTC)
  - `beta_btc`
  - `rev_growth`
  - the revenue-collapse gate
  - `dilution_rate_implied` (backfilled market cap ÷ price, display only)
  - measured `dilution_rate` (null until enough live supply history exists; the only one that may drive a tier).
- **Unlock data:** none exists (the `screener_manual_unlocks` table isn't built). The overhang gate and the unlock tier rule stay not evaluable until it is.
- **Regime thresholds:** unvalidated; review after ~2026-10-20.
- **Rating tiers and setup tags** are Phase 3, using the revised tier rules in config.

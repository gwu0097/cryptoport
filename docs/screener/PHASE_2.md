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

Tests: 213 pass, including new ones for the metric formulas (null handling, the $1M floor, mechanism-gated capture), gates, config validation and hashing, regime rules and percentiles, and dominant-sector selection.

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

**Until ~2026-10-20 the label can only be NEUTRAL** (or FROTH, if OI builds faster than expected). From then on, at ~58–59% dominance, **BTC_LED will fire most days**. If the label doesn't vary over the first month with full inputs, the thresholds need revising, not the label trusting (recorded in `config.regime.validated: false` and SPEC). The funding history is deduplicated to one value per UTC day (the latest run that day), so extra manual or re-triggered runs don't weight a day twice.

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

The 11 `not_evaluable` on the market cap and volume gates are assets with those values missing. They're still unrated, because **core data** is the gate that owns "market cap missing → unrated" (it fails on a null market cap). The floor gates just don't double-count it.

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
  - `dilution_rate_implied` (backfilled market cap ÷ price, display only). The column exists, but nothing writes it yet; it's null for every 2a row.
  - measured `dilution_rate` (null until enough live supply history exists; the only one that may drive a tier).
- **Unlock data:** none exists (the `screener_manual_unlocks` table isn't built). The overhang gate and the unlock tier rule stay not evaluable until it is.
- **Regime thresholds:** unvalidated; review after ~2026-10-20. **Specific revisit item:** BTC_LED's "flat stablecoins" clause (±1%) sits right where today's value is (0.94% from the snapshot endpoint vs 1.15% from the history endpoint). It can flip on which DefiLlama endpoint defines "a month ago". Either widen the band or use the history endpoint's 30-points-back definition. Decide in 2b or later.
- **Rating tiers and setup tags** are Phase 3, using the revised tier rules in config.

---

# Phase 2b — history-derived metrics

## What I built

- **`history.ts`** (pure, tested): `mom_3w`/`mom_12w` (the change in the asset's price measured in BTC, as a ratio), `beta_btc` (90 days of daily log returns regressed on BTC's, needing ≥ 60 paired days), `rev_90d_change` and `rev_growth` (from the stored rolling 30-day revenue totals at t, −30, −60, and −90, −120, −150), `dilution_rate_implied` (market cap ÷ price at t vs t−90, annualized over the *actual* gap between readings), and measured `dilution_rate` (live `circulating_supply` only; null until ~2026-12-21). One reading per asset per UTC day (the latest), ±2-day tolerance on lookbacks, and nothing observed after the run's own timestamp.
- **The revenue-collapse gate is now evaluated**: a fall of more than 60% vs the prior 90 days means unrated.
- **BTC reference, paired by moment:**
  - The live snapshot job adds `bitcoin` to the same CoinGecko `/coins/markets` call and stores its price in the run's `notes.reference_prices`, so each live asset price has a BTC price from the same response.
  - Older live runs get DefiLlama's BTC price at their exact `observed_at`, written back into their notes once.
  - Backfilled rows pair with BTC on **their backfill run's own time-of-day grid** (see "What surprised me").
- **`derive.ts`** loads each asset's history window (the last ~95 days in full, plus narrow windows at t−120 and t−150) with keyset pagination. No schema change: every column already existed from 2a.
- **`scripts/check-screener-schema.mjs`**: the pre-push schema preflight (in CLAUDE.md's verification gate). It checks every `screener_*` table and column in `db/schema.sql` against the live database, and was tested with an injected missing column (exit 1).

## What I verified

Run `a1a3d6dd` (a live snapshot plus derivations, 2026-09-22 ~23:3x UTC):

**Timing (the read-path risk):**

| Step | Time |
|---|---|
| History read (73,138 rows) | 21 s |
| BTC reference | 16 s (7 grids: one per backfill run in the window, plus midnight) |
| Compute + write | 1.3 s |
| **Derivations total** | **~40 s** |
| **Whole cron** | **~52 s of 300 s** |

That's under the ~60 s threshold for the read, so **no Postgres function was needed.** The BTC reference gets cheaper as backfilled rows age out of the window.

**Coverage (all 682 / rated 76):** mom_3w 627/76 · mom_12w 628/71 · beta_btc 571/75 · rev_growth 483/75 · rev_90d_change 459/68 · dilution_rate_implied 574/71 · **dilution_rate 0/0** (by design until ~2026-12-21).

**Revenue-collapse gate:** 339 pass, 120 fail, 223 not evaluable (not enough history). **Rated fell 80 → 76**, because four assets failed only this gate: USUAL (−64%), EDGE (−61%), CHIP (−89%), BASED (−64%).

**Rated distributions:**
- beta_btc: median 1.13 (p10 0.51, p90 1.53)
- mom_3w: median +12% (p10 −13%, p90 +59%)
- mom_12w: median +7% (p10 −31%, p90 +95%)

**Independent spot checks** (none of our code; CoinGecko's own prices and DefiLlama's parent-page daily revenue):

| Check | Ours | Independent |
|---|---|---|
| UNI mom_3w, at the same moments (CoinGecko hourly) | 0.5690 | 0.5688 |
| AAVE mom_3w, same moments (nearest hourly point is 28 min off) | 0.0517 | 0.0481 |
| HYPE / AAVE / UNI beta (CoinGecko close-to-close, a different sampling time) | 1.19 / 1.41 / 1.33 | 1.29 / 1.39 / 1.26 |
| UNI / HYPE / GMX rev_90d_change (parent-page daily sums) | 102.9% / −3.8% / −2.9% | 102.9% / −3.4% / −1.7% |
| UNI / HYPE / GMX rev_growth | 76.9% / 29.4% / −0.6% | 78.0% / 29.5% / −1.2% |

A naive momentum check against CoinGecko's *daily* points disagreed (UNI 56.9% vs 75.3%). That comparison wasn't like for like: those points are at 00:00 and our start reading is at 21:32 the same day. At the same moments it matches to 4 decimal places.

Tests: 231 pass, including the pairing tests and the plausibility check. One of them reproduces the bug below: the correct pairing gives beta exactly 2, and pairing on the wrong time of day collapses it.

## What surprised me

**"Daily point" isn't a moment, and the first 2b run showed it.** Median beta among rated assets came out **0.07**. DefiLlama's `/chart` spaces its points from the requested start time, so every backfilled price is DefiLlama's price **at that backfill run's time of day**. HYPE's stored 09-01 price, 82.046, is its 21:31 price; 00:00 was 84.16. My BTC reference was fetched on a 00:00 grid, so every backfilled return was offset ~21.5 hours from its BTC return: "daily vs daily" in name, different moments in fact. Fixed by pairing each backfilled row with BTC on its own run's grid. That grid time was verified on rows from two different backfill runs, matching to 15 digits. Median beta is now **1.13**. This is SPEC's levels rule applied one level deeper, and SPEC now says so explicitly.

**Plausibility check** (added after the beta bug; see SPEC): on this run it flagged one rated asset, NEAR (float ratio 1.000000006, CoinGecko's two supply fields sampled a moment apart), which set a 0.1% slack on that bound. The rated medians are all inside their ranges.

## Open items

- **Scope gap (a decision for Phase 3):** NEAR, an L1 token, is rated. DefiLlama files NEAR Intents (Bridge) and NEAR Perps under the parent "NEAR Protocol", whose CoinGecko id is the L1 token, so the category-based out-of-scope gate can't see it. It's valued on ~$1.4M/month of app revenue in oracles_infra.
- **Measured `dilution_rate`** is null until ~2026-12-21 (90 days of live supply), so the dilution tier rules can't fire before then. The implied figure is display only.
- **Unlock data:** still none. The overhang gate and unlock tier rule stay not evaluable.
- **Stablecoin 30-day change:** switches to stored history ~2026-10-22 (BACKLOG).
- **Regime thresholds:** review after ~2026-10-20.
- **Next, Phase 3:** tiers (with the revised rules and per-rule coverage), Score B, grades and setup tags.

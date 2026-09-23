# Pre-registration: the weekly-horizon momentum test

**Registered 2026-09-23, before any weekly-horizon number has been computed.** This is the one further experiment approved after Phase 4 (SPEC, "Product"). It's registered in full so it's a test rather than a search: universes, signals, horizon, statistics, decision rules and my prediction are all fixed here. **Nothing may be added after results are seen.** Any other signal, horizon, universe or filter would be a new registration, made before running it.

## Why this test
Published crypto momentum results (Liu, Tsyvinski & Wu) are at **weekly** horizons (1–4 weeks) on a **broad** coin universe. Our Phase 4 test was **monthly** on ~60–80 revenue-generating tokens, and found nothing on the rated universe and in-sample reversal on the deeper universe. A weekly test is closer to the published setup and has about 4× the periods. It asks one question: **does short-horizon momentum continuation exist in the data we have?**

## Contamination, stated up front
- **U-A** (below) uses the deep-store price paths (2023-05 → 2026-09) that Phase 4 already examined at the monthly horizon. There, 30-day momentum reversed in-sample. So U-A is a **pre-registered test of a new horizon on already-examined data**, not a clean out-of-sample test.
- **U-B** is the clean one: it uses only data that doesn't exist yet.
- A result counts toward reopening the ranking question only as the rules below allow.

## Universes (each is separate evidence; never pooled)
- **U-A: historical, broader.** Every asset in the deep store (`~/cryptoport-archive/screener/deep/`, manifest dated 2026-09-23) that has a price on D, D−7, D−21 and D+7 (the 00:00 UTC grid; BTC from the same grid).
  - **No** revenue floor, market-cap, volume or scope filters (none exist that far back, and "broader" is the point). So it includes the out-of-scope and unrated assets in the store.
  - **One exclusion, fixed here:** an asset is excluded from a period if its price's coefficient of variation over D−27 … D is below 0.5%. That's pegged or stable assets, whose ties would only add noise.
  - Known limits: it's protocol tokens only (not a broad coin universe), survivor-selected (today's matched assets; bound 3.1–3.8% from `PHASE_4.md`), and has no liquidity filter.
- **U-B: confirmatory, the production rated universe.** Live snapshot days **after 2026-09-23** only, one run per UTC day by `pickRunPerUtcDay`, degraded days excluded. The population is the assets rated at D.

## Horizon and formation dates
- **Forward return:** 7 days vs BTC, ratio form: `fwd = (P(D+7)/P(D)) / (BTC(D+7)/BTC(D)) − 1`. Exact dates, no nearby-day substitution, and BTC paired at each reading's own moment (SPEC rules).
- **U-A formation dates:** D_last = the store's last date − 7 = **2026-09-15**, then back in steps of exactly 7 days while D ≥ **2023-06-24** (21-day lookback plus the 28-day stability window from the store's first date, 2023-05-27). That's about 169 periods.
- **U-B formation dates:** the first live day on or after **2026-09-24**, then every 7 days.

## Signals: exactly two, both "higher = predicted better" (continuation, the published claim)
- **S1:** 3-week momentum vs BTC: the production `mom_3w` (21 days, `history.ts`), computed by the production code.
- **S2:** 1-week momentum vs BTC: the same production function (`momentumVsBtc`) with 7 days. It will be exported for reuse, **not re-implemented** (SPEC: the backtest never gets its own scoring code).

## Statistics
- **Rank IC per period:** Spearman, average ranks for ties (Phase 4 definitions). A period with fewer than **20** assets is skipped and counted.
- **Summary:** the mean IC with a **Newey–West** standard error (Bartlett kernel, lag 3), because S1's 21-day lookback overlaps across consecutive weekly periods, so the IC series can be autocorrelated and a plain t would overstate. The plain t is reported alongside, but **verdicts use the Newey–West interval**.
- **Multiple testing:** there are two signals, so verdict intervals are **97.5%** (Bonferroni: t_{0.9875, n−1} × the Newey–West standard error).
- **Tercile spread:** positional terciles (Phase 4 clarification). Reported, but it doesn't drive a verdict.
- **Held-back third:** the last ⌈n/3⌉ periods, in time order.
- **Secondary:** the IC against the raw 7-day return (the published form), descriptive only, with no verdict.

## Decision rules (per universe, per signal)

| Verdict | Condition |
|---|---|
| **Continuation supported** | training mean IC > 0 **and** holdout mean IC > 0 **and** the holdout's 97.5% Newey–West CI lower bound > 0 |
| **Reversal supported** | training mean IC < 0 **and** holdout mean IC < 0 **and** the holdout's 97.5% Newey–West CI upper bound < 0 |
| **Inconclusive** | anything else |

- **U-B:** no verdict before **24** periods (about 2027-03). Until then it's "insufficient data".
- **What a verdict does:** nothing in production changes automatically.
  - "Continuation supported" in **U-A alone** is evidence from a different universe than the one the screener rates, and is reported as such.
  - Only "continuation supported" in **both** U-A and U-B would reopen the question of ranking by momentum, and even then any change needs the user's explicit approval.
  - "Reversal supported" doesn't make a reversal ranking either; it answers the SPEC open question against the design.

## My prediction (recorded before anything is computed)
- **U-A, S1 (3-week): reversal or inconclusive**, not continuation. These are the same price paths on which 30-day momentum reversed in-sample.
- **U-A, S2 (1-week): inconclusive.** Short-term reversal is plausible in a universe with many small, illiquid tokens and no liquidity filter.
- **U-B:** insufficient data until ~2027-03.
- **What would surprise me:** "continuation supported" for S1 in U-A. That would contradict the monthly result on the same data, and would deserve scrutiny before belief.

## Cost and constraints
- **U-A:** zero new API calls (the deep store exists) and zero CoinGecko calls. Runs as a new `screener_backtest_runs` row whose `prediction` is this file's "My prediction" section, verbatim, inserted before computing.
- **U-B:** uses the daily job's live snapshots, which keep running.
- **Not run yet.** It runs only when the user asks.

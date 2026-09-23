# Pre-registration: pullback / trend indicators on the Signals page

**Registered 2026-09-23, before any of these indicators has been implemented or backtested.** The indicator rules and parameters in §2 were set by the user; they're fixed here and **won't change after results are seen**. The harness method in §4 is a proposal pending the user's sign-off at Checkpoint A. If it changes, the change is recorded in §9 (amendments), dated, **before any backtest runs**.

## 1. Context: there is no existing SMC harness
The SMC v4.2 banner ("profit factor 0.88 at 6bps round trip; a random-entry control beat it in 41% of trials") is **hard-coded text** in `src/app/(app)/signals/page.tsx`, copied from the user's spec (`external/smc_signal_overlay_spec.md` §2). The spec presents those numbers as given, from a backtest of the user's live BTC bot run outside this project. Its cost model, random-control design, venue and period are **not recorded anywhere in this project**.

So this experiment builds the **one** backtest harness (§4) and runs **all five** indicators through it: the four below **and SMC v4.2**, so SMC's verdict is also measured under the same method. The spec's external figures are kept only as a labeled, unreproduced reference.

## 2. The indicators: rules and parameters (fixed)
All are long-only, use completed candles only, and follow the same Delay=1 execution convention (§3). Parameters are the round published values; **they are not tuned**.

| # | Indicator | Trend filter | Entry (setup) | Exit |
|---|---|---|---|---|
| 1 | **RSI(2) pullback** (Connors) | close > SMA(200) | Wilder RSI(2) < 10 | close > SMA(5) |
| 2 | **Bollinger pullback** | close > SMA(200) | %B ≤ 0 on BB(20, 2) | close ≥ middle band |
| 3 | **MA pullback** | close > SMA(200) **and** EMA(20) > EMA(50) | candle low ≤ EMA(20) **while** close > EMA(50) | close < EMA(50) |
| 4 | **Donchian breakout** (Turtle System 2, long-only), the trend-following control | none | close > prior 55-bar high | close < prior 20-bar low |
| 5 | **SMC v4.2** (existing, `src/lib/smc/engine.ts`) | | BUY flip | SELL flip |

**Definitions** (all on closes unless stated; "bar t" is a completed candle):
- **SMA(n)**: the simple mean of the n closes ending at bar t, bar t included.
- **EMA(n)**: α = 2/(n+1), seeded with SMA(n) at the n-th bar.
- **Wilder RSI(2)**: gains and losses of close-to-close changes, each smoothed with Wilder's RMA(2) (seeded with the simple mean of the first 2 changes, then (prev·(n−1)+x)/n), RSI = 100·avgGain/(avgGain+avgLoss). Same as Pine `ta.rsi`.
- **BB(20, 2)**: middle = SMA(20); upper and lower = middle ± 2·σ, with σ the **population** standard deviation of the 20 closes ending at bar t (Pine `ta.stdev` default). %B = (close − lower)/(upper − lower).
- **Prior 55-bar high / prior 20-bar low**: the max high / min low over the 55 / 20 bars **before** bar t, bar t excluded.
- **Position logic:** at most one position per token. Entry is checked only while flat, exit only while long. The trend filter and setup must hold on the **same** completed bar. There's no stop and no profit target beyond the exit rule.

**Deviations from the originals, labeled:**
- Connors (RSI(2)) and Turtle System 2 were defined on **daily** bars. On 1H and 4H the parameters are **bar counts, not days**. That's a deviation from the originals.
- Turtle System 2 also used N-based (ATR) 2N stops, position sizing and pyramiding. **All omitted here** (long-only, no stops, no pyramiding).
- The Bollinger and MA pullback rules are the user's formulations, not attributed to a single published source.

## 3. Execution convention (Delay = 1, non-repainting)
- **Candles** are Hyperliquid `candleSnapshot`. Only **completed** candles are used; the last candle returned is still forming and is dropped.
- **Indicators 1–4:** a condition is evaluated on the close of completed bar t, and the order fills at the **open of bar t+1**. The forming bar is never acted on.
- **SMC v4.2:** as in `engine.ts`. A flip is known at the end of a completed 3× block, which is the open of the first candle of the next block. The order fills at **that candle's open** (the candle the label prints on).
- **Warmup:** no signal until every input of the rule is defined. That's 200 bars for the SMA(200) filters, 55 for Donchian, and 8 completed blocks for SMC.

## 4. Harness (PROPOSAL, pending the user's sign-off)
**Data:**
- Hyperliquid candles, **only candles with a trade count `n > 0`**. Hyperliquid returns 1D candles back to 2020 for BTC with `n = 0` before its own launch; those are imported, not venue trades, and are excluded.
- Depth per timeframe:
  - **1H**: the API's last ~5,000 candles (~208 days).
  - **4H**: ~5,000 (~833 days).
  - **1D**: everything since the perp's listing.
- Hyperliquid funding history (`fundingHistory`, hourly).

**Universe:** the Hyperliquid perps on the user's watchlists at registration, 37:
kPEPE, PONS, ZEC, VVV, PUMP, TAO, UNI, JTO, VIRTUAL, SUI, NEAR, HYPE, SOL, CASHCAT, CRV, LIT, ARB, ONDO, MORPHO, JUP, ENA, PENGU, INJ, FET, USELESS, CC, XMR, DASH, WIF, TRUMP, kBONK, AAVE, W, DOGE, AVAX, ETH, MET.
Plus **BTC as a reference asset**, because SMC's only prior claim is about BTC. That's 38 tokens.

**Cost model:**
- **Primary, used for verdicts:**
  - taker fee **4.5 bps per side** (Hyperliquid Tier 0, verified 2026-09-23);
  - plus an assumed **2 bps slippage per side**;
  - = **13 bps per round trip**;
  - plus **funding**: every hourly funding payment strictly after the entry fill and at or before the exit fill is charged at its rate × notional (a long pays a positive rate and receives a negative one).
- **Sensitivity only (no verdict):** 6 bps round trip, no funding, for comparability with the spec's external SMC figure.
- **Per-trade net return** = exit fill / entry fill − 1 − round-trip costs − Σ funding. Constant notional, no compounding.

**Metrics** (per indicator × timeframe × token, and pooled over tokens per indicator × timeframe):
- trade count;
- win rate (net return > 0);
- **profit factor** = Σ positive net returns / |Σ negative net returns| ("no losing trades" if there are none);
- mean net return per trade.

**Random-entry control:**
- For each indicator × timeframe × token × segment: **1,000 trials**.
- Each trial places the **same number of trades** as the indicator did, with holding periods **drawn without replacement from the indicator's own holding periods**: matched count **and** matched holding-time distribution.
- Entry bars are uniformly random among eligible post-warmup bars in the segment, with no overlapping positions (rejection sampling).
- Same fill convention, same costs, same funding.
- **Statistic:** the % of trials whose profit factor ≥ the indicator's (ties count against the indicator).
- **Pooled:** trial k is the union of every token's trial k.

**Held-back third:**
- Each token's tradable (post-warmup) window is split by bar count. The first two-thirds is **training**; the last third is **holdout**.
- Segments are run independently: flat at each segment's start, and any position still open at a segment's end is closed at its last completed close and marked "forced exit".

**Verdict** (the only thing a banner may state), per indicator × timeframe, **pooled**:

| Banner | Condition |
|---|---|
| **"beats random"** | fewer than 5% of random trials beat it in training **and** fewer than 5% in the holdout |
| **"does not beat random"** | otherwise |
| **"insufficient trades"** | fewer than 30 pooled trades in either segment |

- The banner also states the holdout profit factor after costs.
- Per-token results are shown in tables, but **never drive a banner**.

## 5. How many tests, and chance
- 5 indicators × 3 timeframes × 38 tokens = **570 per-token tests**, plus 15 pooled verdicts (each needing two segments).
- **With no real edge anywhere**, about 5% of per-token results (~28) should still look like they "beat random" by chance.
- A pooled verdict requiring training **and** holdout below 5% has roughly a 0.25% chance of a false pass if the segments are independent. That's about 0.04 expected false passes across 15.
- The report will state these numbers next to the results.

## 6. Independent check (SPEC rule: verify with a different tool)
- **RSI(2) pullback on BTC, 4H.** A separate agent with a fresh context gets **only §2–§3 of this document** and the raw candle file. It recomputes the trade list (entry/exit bar, fill prices) in stdlib Python without importing our code.
- Our trade list must match exactly. Any mismatch is reported, with the ambiguity that caused it.

## 7. `nextTrigger`: exact or not shown
The trigger is the price at which **the forming bar's close** would satisfy the rule, with everything else fixed. It's shown **only where it can be computed exactly**. Where it can't, the current indicator value is shown instead, never an approximation passed off as exact.

Notation: `x` is the forming bar's close; S(k) is the sum of the last k completed closes.

| Indicator | Entry trigger | Exit trigger |
|---|---|---|
| RSI(2) | **Exact** (see below) | **Exact:** close > SMA(5) ⇔ x > S(4)/4 |
| Bollinger | **Exact** (see below) | **Exact:** x ≥ S(19)/19 |
| MA pullback | **Not exact → value shown** (see below) | **Exact:** x < EMA50_prev |
| Donchian | **Exact:** x > prior 55-bar high | **Exact:** x < prior 20-bar low |
| SMC | **Exact** (existing: x vs o + 7(O − C)) | same |

- **RSI(2) entry.** RSI falls monotonically as x falls, so the setup threshold x* solves RSI(x) = 10 piecewise.
  - With p = the last close and avgU, avgD the previous Wilder averages: if avgD > 9·avgU then x* = p + (avgD − 9·avgU)/9; else x* = p + avgD − 9·avgU.
  - The trend filter at the same close is x > S(199)/199.
  - The entry trigger is the interval S(199)/199 < x < x* (empty ⇒ no trigger this bar).
- **Bollinger entry.** %B ≤ 0 ⇔ x ≤ SMA20(x) − 2σ(x), a quadratic inequality in x, solved in closed form.
- **MA pullback entry.** It depends on the forming bar's **low and close** together (low ≤ EMA20(x), with EMA20 moving with the close), so there's no single price. The current EMA(20) and EMA(50) values are shown, labeled as moving with the close.

**Distance** = (trigger − last close) / last close, only when a trigger exists.

## 8. Out of scope
- No consensus, aggregate or "N of 5 agree" anywhere.
- No parameter search.
- No short side.
- No order placement.
- No new daily storage; indicators are computed on page load.

## 9. Amendments

### Amendment 1 — 2026-09-23, user sign-off at Checkpoint A (recorded before any indicator is implemented or backtested)
1. **Harness approved as proposed in §4**: one harness for all five indicators, SMC v4.2 re-measured in it. Its banner meanwhile says its figures are external and unreproduced (commit `77789d2`).
2. **Verdicts come from the POOLED result only: 15 primary tests** (5 indicators × 3 timeframes), not 570. Per-token results are **description only** and never drive a banner or a verdict. §5's 570 per-token count stays reported, as a reminder of how many things were looked at.
3. **Primary cost model** (decides verdicts): 13 bps round trip + actual Hyperliquid funding. **Stress case: 30 bps round trip + actual funding**, reported for every test. **Cost-sensitive flag:** an indicator × timeframe whose pooled verdict or holdout profit-factor side (above/below 1) differs between 13 bps and 30 bps is labeled **"cost-sensitive"**, because thin tokens pay more than 2 bps slippage. The 6 bps no-funding sensitivity stays as the comparison with the spec's external SMC figure; it decides nothing.
4. **Random control approved:** 1,000 trials, matched count and holding-time distribution, same costs and funding.
5. **Universe approved:** the 37 watchlist perps + BTC.
6. **1H is low-power by construction.** Only ~208 days of 1H candles exist, so the holdout third is ~70 days. **Every 1H verdict is labeled "low-power", whatever the outcome.**
7. Data depth as found (§4).

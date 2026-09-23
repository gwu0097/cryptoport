# Ambiguities in definitions.md and how the verifier resolved them

For each item: what the spec leaves open, the readings, what verifier.py does, and whether it matters in this data. Where it was cheap, I also ran the alternative. Its numbers are in `alternatives.json` and in the output of `alt_btc.py`.

## A. Items that could change a number

1. **Tercile membership when ties straddle the ⌈n/3⌉ boundary.** The spec says "rank ... (ties: average rank)" and then "top ⌈n/3⌉ positions after sorting descending, ties broken by gecko_id ascending". Those two rules conflict.
   - Reading 1 (chosen): positional. Sort by (factor desc, gecko_id asc). Top = the first ⌈n/3⌉ rows and bottom = the last ⌈n/3⌉ rows. The groups always have exactly ⌈n/3⌉ members.
   - Reading 2: rank threshold. Top = rows whose average descending rank is ≤ ⌈n/3⌉, and bottom = rows whose rank is ≥ n−⌈n/3⌉+1. A tied block can then leave the top group smaller than ⌈n/3⌉.
   - Impact: only `timing_score` is affected, because it takes discrete values (about 53 distinct values across 62 rated assets). The mean spread changes as follows. 1y h30: 0.0935 → 0.0936 (2 of 9 periods differ). 2y h30: −0.0336 → −0.0305 (11 of 24). 3y h30: −0.0392 → −0.0361 (17 of 36). 2y h90: −0.0454 → −0.0400. 3y h90: −0.0119 → −0.0076. No sign changes, and no CI crosses 0 under either reading. The momentum factors, beta and the valuation factors have no boundary ties, so they are identical under both readings.
   - The spec also doesn't say whether the gecko_id tie-break applies to the bottom group in the same direction. Under reading 1 the bottom group is simply the tail of the same sorted list, so tied rows at the bottom boundary go in gecko_id-descending order. I used that.

2. **Sign flip vs tie-break for the cheapness factors (`−ps_circ`, `−pf_circ`, `−dilution_rate_implied`).** Two readings:
   - Negate first, then sort by (−value desc, gecko asc). Chosen.
   - Sort raw values descending with gecko asc, then reverse the list. Ties then run gecko descending.
   - These give different spreads only when a tie sits at the boundary. In this data they are identical in every period (0 periods differ). The IC is unaffected either way, since IC(−x) = −IC(x) exactly.

3. **Which BTC price goes into fwd_btc.** The spec says "the BTC price is from the same backfill grid as the asset's, the same pairing rule as history.ts". I cannot see history.ts. The CSV has a separate btc_d/btc_d30/btc_d90 on every row, and in the 1y panel these differ within a date: 371 rows are more than 0.5% off that date's median, 29 of them rated, with a maximum spread of 4.8%. One example is 2026-02-23, where a group of rows sit 4.65% above the median. In 2y and 3y they are constant within each date.
   - Chosen: each row's own btc_d and btc_dh, taken to be the per-asset timestamp pairing.
   - Alternative: one BTC price per date (the median). Under this reading fwd_btc is a monotone transform of the raw return within a date, so the IC equals the raw-return IC.
   - Impact, 1y h30 mean IC (per-row → per-date): timing_score −0.0238 → −0.0230, mom_3w −0.0011 → +0.0004 (a sign flip, though the value is essentially zero; t goes −0.05 → +0.02), mom_12w −0.0430 → −0.0436, beta_btc 0.1569 → 0.1577, −ps −0.0784 → −0.0777, −pf −0.0646 → −0.0640, −dil −0.0463 → −0.0466. No conclusion changes. 2y and 3y are unaffected.
   - I cannot tell from these files whether a 4.65% gap between two assets' BTC prices "at the same moment" is intended. On 2026-02-23 a block of mostly unrated rows is paired with a quite different BTC price. **Worth checking on the implementation side.**

4. **Where the n ≥ 10 check applies.** Readings: after removing rows with a null factor or null forward return (chosen, following "each factor is tested on the rated assets where both ... are non-null"), or before, on rated assets only. The smallest population in any period is 38 (3y, 2023-10-08, mom legs) and the smallest before the factor filter is 40. Nothing gets near 10, so the choice doesn't matter here. All windows skip 0 periods.

5. **n for the held-back third.** The spec says "the last ⌈n/3⌉ periods". n could be the number of formation dates, or the number of periods that have an IC. I used the formation dates. The two are identical here because nothing is skipped. Holdout sizes: 1y 3/9, 2y 8/24, 3y 12/36.
   - "Same sign" is ambiguous for a mean of exactly 0. I treat 0 as matching nothing, but it never occurs. For 3y mom_12w (holdout −0.0007) and 1y mom_12w (−0.002) the sign is effectively noise.
   - "CI excludes 0": I require strict exclusion.
   - The 1y holdout has n=3, so df=2 and t=4.303. The spec itself says this makes (ii) nearly unreachable, so a "fail" there is structural and not evidence against the factor.

6. **Formation-date start rule** ("while D ≥ the first date on which at least 30 rated assets have both momentum legs"). These files can confirm that every date present satisfies the rule. The minimum count of rated assets with both momentum legs is 55 in 1y, 81 in 2y and 38 in 3y. The files cannot confirm that the first date is actually where the rule binds, because no earlier dates are included. The 2y and 3y first dates (2024-10-02, 2023-10-08) look like window-length boundaries, not the ≥30 rule. The rule is also ambiguous about whether "rated" here means the window's own rated universe; the 2y/3y panels use a different, labeled universe. **Unverifiable from these files.**

7. **The last data date differs between windows.** 1y ends at D_last = 2026-08-22 (data through 2026-09-21, as the spec states). 2y and 3y end at 2026-08-23, which implies data through 2026-09-22. So the 2y and 3y date grids are shifted one day from the 1y grid, not nested in it. I report this as found and do not reconcile it.

## B. Items that are ambiguous but didn't matter in this data

8. **Mismatch between the recomputed fwd_btc and the given columns.** The task says to use the recomputed value. There are 0 mismatches in every window: the max absolute difference is exactly 0.0 for both fwd30 and fwd90, and in no row is one side null while the other is not. So which one is used downstream makes no difference.
9. **Null handling in fwd.** A zero price would also be treated as missing, but there are no zero prices.
10. **An IC is undefined when either rank vector is constant.** I skip the period and count it. This never happened.
11. **Average ranks for the IC.** Ties in both the factor and fwd_btc get average ranks, and the IC is the Pearson correlation of the ranks, as specified. The negated factors have exactly the negated IC.
12. **"Mean fwd_btc of the top tercile".** I took this as the simple arithmetic mean of each row's fwd_btc, not a compounded or log mean.
13. **Summary statistics.** sd is the sample standard deviation (n−1). t = mean/(s/√n). The CI uses t_{0.975,n−1}. The spec says spread summaries are "the same stats" but lists only "mean, t and CI", so I also report sd.
14. **h=90 formation dates.** The spec builds them independently (last data date − 90, step 90). The in_90d_set flag agrees with that construction exactly: it marks every third 30-day date, and the last flagged date = last 30-day date − 60. Consecutive flagged dates are exactly 90 days apart, and consecutive 30-day dates exactly 30 days apart. All checks pass in all three windows.
15. **h=90 skips.** A row whose D+90 price is missing is excluded from that period. There are no h=90 skips, because only the last two 30-day dates lack D+90 prices and those dates are not in the 90-day set.
16. **Other claims taken as given.** "Rated" (kill filters at D), "nothing interpolated", and "the 2y/3y universe = deep price + $1M revenue floor" cannot be checked from these columns. The `rated` column is taken as given.

## C. Observations (not ambiguities)

- **Results flip between windows** (reported, not averaged):
  - beta_btc h30: 1y IC +0.157 (t=4.06, CI excludes 0), 2y −0.007, 3y −0.023.
  - timing_score h30: 1y −0.024 (not significant), 3y −0.051 (t=−2.46, CI [−0.093, −0.009], excludes 0 on the negative side).
  - mom_12w h30: 3y −0.053 (t=−2.56, CI excludes 0, negative).
  - Tercile spreads for timing_score and mom_3w are positive in 1y (+0.09) and negative in 2y/3y.
- **Holdout results at h30.** In 2y and 3y every training mean IC is negative. Every holdout mean IC is positive, except 3y mom_12w (−0.0007) and 2y mom_12w (+0.0005), which are about 0. In 1y, timing_score and mom_3w flip sign between training and holdout. The other five 1y factors keep the same sign, but no holdout CI excludes 0 anywhere. The result is **0 passes in every window**.
- **The mom_12w sign test depends on noise.** It "passes" part (i) of the rule in 3y and fails it in 2y purely because its holdout mean is about ±0.0005. That is not a meaningful distinction.

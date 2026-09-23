# Phase 4b independent verifier (evidence)

Written 2026-09-23 by a **separate agent with a fresh context** that was given **only** `INPUT_definitions.md` (the Definitions section of `PHASE_4_PLAN.md`, verbatim) and the three exported panel CSVs. It was told not to read any source code, scripts, docs or git history, and to write stdlib-only Python. It never saw `src/lib/screener/backtestStats.ts` or `scripts/screener-backtest-run.ts`.

- `verifier.py`: its implementation. `alt_btc.py`: the alternative BTC-pairing reading it tested.
- `AMBIGUITIES.md`: every place it found the definitions admitted more than one reading, which one it chose, and the effect of the alternative. The resolutions are in `PHASE_4.md` (4b, "Independent check").

Result against backtest run `d7cf95ae`: **404/404** (window, horizon, factor, period) IC and tercile-spread cells equal within 1e-9. Summaries and holdout outcomes also equal. It recomputed every forward return from raw prices: 0 mismatches.

What this does and doesn't establish: the verifier's author hadn't seen the implementation, so a misreading on the implementation side wasn't copied, and ambiguities in the text surfaced as explicit choices, not as a shared silent pick. It is the same underlying model, and both sides read the same definitions text. A misreading **of that text** that both happened to make the same way would still pass.

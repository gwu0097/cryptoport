# Handoff — screener project, Phase 1 → Phase 2

Written because this session is restarting on a new model. Everything substantive is in the files below — this doc is a pointer + the small residue that isn't naturally part of any of them.

**Canonical location**: `cryptoport/docs/screener/` (this folder, in git). An earlier copy at `/Users/raitsai/appDevelopmentWorkSpace/crypto-fundamentals-recon/` is now stale/superseded — this repo copy is the one to read and edit; the old folder can be deleted whenever convenient (left in place only because this session couldn't remove it itself).

## Read in this order

1. **`SPEC.md`** (this folder) — the current, authoritative spec. Original v2 build prompt in full, amended inline by every methodology/architecture decision made during Phase 0/1. Read the amendments section before the original text below it — the original is base reference, not current truth where it's been superseded.
2. **`PHASE_0.md`** (this folder) — recon: csp-screener architecture survey, data-source verification, placement decision reasoning, DB schema design reasoning.
3. **`PHASE_1.md`** (this folder) — what was actually built and verified for Phase 1, including two real bugs caught (parent/child protocol resolution, a pagination-caused duplication incident) and the full sign-off Q&A (double-count checks, universe reconciliation, DB constraint, cron proof, price-history-depth testing).
4. **`/Users/raitsai/appDevelopmentWorkSpace/cryptoport/BACKLOG.md`** — committed, separate from this folder (repo root). Unrelated-to-screener backlog items live here too (Trend Finder, SMC overlay, transactions chain gaps, trending tab) — don't confuse those with screener scope.
5. **`DATA_SOURCES.md`** (this folder) — raw verification detail for every external API touched; `SPEC.md`'s amendments summarize the load-bearing findings, this has the full detail if you need it.

## Repo state as of this handoff

- **Screener code is real, tested, and working, but deliberately uncommitted.** `git status` shows `src/lib/screener/*`, `src/app/(app)/screener/`, `src/app/api/cron/screener-snapshot/`, `src/components/screener/` all untracked — per the user's own explicit instruction ("leave uncommitted for review... I'll review and commit Phase 1, then deploy"). Don't assume it needs rebuilding; it needs review and a commit.
- **`BACKLOG.md` is committed** (unlike the screener code) — it's pure documentation, not app behavior, and was explicitly asked to be committed.
- **Unrelated Dashboard work shipped and deployed this same session** (a mover-list held-value feature, color tiers, a CoinGecko link) — already live in production, not screener-related, mentioned only so it isn't mistaken for unfinished screener work if you see it in git log.
- A handful of `diag_screener_*` scratch scripts are untracked in the repo root (read-only verification scripts used during Phase 1 sign-off) — fine to leave per this repo's own established convention (`CLAUDE.md`: "Read-only ones can stay").

## Genuinely open decisions — not resolved, need a human call before the code that depends on them gets built

These didn't fit naturally into SPEC.md's amendments because they're forward-looking questions, not decisions already made:

1. **`KNOWN_HOLDER_VALUE_MECHANISMS` needs real entries.** Six were referenced in chat (HYPE, PUMP, SKY active; AAVE paused; ENA, LDO conditional) but the attachment never actually arrived — flagged live at the time, not silently dropped. The config shape is decided (`SPEC.md`); the content is empty. Blocks `capture`/`buyback_yield`/the Quality & Risk Caution tier's "stale/paused/conditional" trigger from being real until filled in.
2. **Phase 5's "top N by Fundamental score" needs a real replacement definition.** That score doesn't exist anymore (Quality & Risk is a tier now, Score B/momentum is primary) — the obvious candidate is "top N by Timing grade among Pass-tier assets," but that's my inference, not a confirmed decision. Needs an explicit call when Phase 5 is reached.
3. **`screener_scoring_runs` vs. reusing `screener_runs` for scoring passes** — flagged as a real design question in `SPEC.md`'s candidate-factor-shape amendment, not decided. A scoring pass (Phase 2/3) might run on a different cadence than the daily snapshot job, which would argue for a separate table; not urgent until Phase 2 actually builds scoring.
4. **Cron proof is code-complete but empirically unverified.** The trigger-recording mechanism is built and should work, but no real scheduled (not manually-triggered) firing has happened yet — can't be confirmed until after the user deploys and a real 07:00 UTC window passes on its own.
5. **Retroactive price-source correction was considered and explicitly reverted** (see `SPEC.md`'s non-negotiable-principles amendment) — if there's ever a real need to upgrade an already-backfilled date's price from CoinGecko to DefiLlama, that needs an efficient (batched, not per-row-round-trip) implementation, not the naive version that got built and then removed for being too slow.

## What NOT to do

- Don't re-verify things already verified live in `PHASE_0.md`/`PHASE_1.md`/`DATA_SOURCES.md` (data source availability, rate limits, the parent/child resolution bug, the historical-mcap absence) — these are settled, cited with real evidence, not open questions.
- Don't rebuild the Quality & Risk design as a score — it's explicitly a tier now, twice-amended in chat specifically to get away from being a score. `SPEC.md`'s amendment section has the exact tier rules.
- Don't assume `PHASE_2.md`'s original text (inside `SPEC.md`, reproduced from the v2 prompt) is buildable as written — most of its metric list references earnings (removed) and the original Score A design (replaced). Read the amendments above it first.

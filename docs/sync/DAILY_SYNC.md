# Daily sync of changed wallets — design (2026-10-02)

## Why

Analytics' "what moved your portfolio" is now measured coin by coin from the
daily wallet snapshot (06:00 UTC, `api/cron/snapshot`). That snapshot values
each wallet's holdings **as of its last sync** — no chain is read. A wallet
the owner traded from but didn't sync looks unchanged until a sync catches
up, so "everything else" lands on the wrong day or is missed. Today wallets
sync only on Sync / Sync all / the Auto-sync-daily wallets on Refresh prices.

Goal: every auto wallet's holdings are fresh before the 06:00 snapshot,
**cheaply** (owner: "we want to try to keep it cheap") — so a full daily
sync of ~60 wallets is out; sync only what changed.

## How others do it

- **Zerion, DeBank, Rabby**: run their own indexers; balances are always
  current — the unit of truth is the indexed chain state. Not an option for
  us (we read balances ourselves; §4.7).
- **Koinly, CoinTracker, CoinStats**: a periodic per-wallet sync through
  provider APIs (daily or on login), each wallet with a "last synced" time;
  many skip wallets with no new transactions since the last sync (the
  provider's "latest transaction" as the change signal).
- **Rotki**: user-triggered, plus periodic per-account balance queries.

Ours follows the second: a cheap "anything new since the last sync?" signal
per wallet each morning, then the full sync (unchanged code) only for wallets
whose signal moved.

## Change signals (per wallet, once a day)

| Wallets | Signal (stored as `wallets.change_signal`) | Source and cost |
|---|---|---|
| Solana (`SOL`) | newest transaction signature | public RPC `getSignaturesForAddress` limit 1 — free (as the bot guard) |
| EVM (`ETH`, multi-chain) | newest transaction id across chains, incoming included | Zerion `/wallets/{a}/transactions?page[size]=1` — 1 call (Zerion 300/day) |
| Bitcoin, single address | `chain_stats.tx_count` + `mempool_stats.tx_count` | Blockstream (free, already used) |
| Cardano | account tx count | Koios (free, already used) |
| Bitcoin xpub, Cosmos, NEAR, SUI, TAO, ICP, XRP, DOT, TON, … | none yet | — weekly baseline below |
| Exchanges (Kraken, Coinbase, Gemini) | none (balances move on the venue) | synced daily: one call to the user's own key, free |
| Manual wallets | — | never synced |

Rules:
- **Changed** (signal differs from the stored one) → full sync; the new
  signal is stored only when the sync succeeds.
- **Unchanged** → no sync; `change_checked_at` set (the wallet shows "no
  changes since <last sync>, checked <time>").
- **Signal unavailable** (source failed, or a chain without one) → synced
  if its last sync is older than **7 days** (the weekly baseline); otherwise
  skipped today and the status says "couldn't check".
- **Auto-sync daily** wallets (`wallets.auto_sync`) → synced daily
  regardless of the signal (unchanged meaning: "always fresh").
- A wallet whose sync fails isn't retried until the next morning (the
  morning-read lesson, audit 2026-10-02).

## Scheduler

Same shape as Wallet Watch's morning read (CLAUDE.md, proven live; never
chain calls to our own site — Vercel 508 after ~4 hops):

- **pg_cron**, every minute **04:00–05:54 UTC**, calls
  `api/cron/sync-tick` (bearer `CRON_SECRET` from Supabase Vault) **only
  while a wallet is due** — checked inside Postgres (`wallets.sync_due_at
  <= now()`), so a finished morning costs nothing.
- The **first tick of the day** runs the change-signal pass for every auto
  wallet of every user (batched: one read of due wallets, signals fetched
  with `mapWithConcurrency`, one batched write) and marks the wallets to
  sync (`sync_due_at = now`); everything else gets `sync_due_at = tomorrow
  04:00`.
- **Every tick** fills free lane slots (`syncLanes.ts`: EVM 2, Solana 1,
  Cosmos 1, each exchange 1, others 1) with one `api/cron/sync-one` call
  each, which claims one due wallet (compare-and-set on `sync_started_at`,
  as `syncWalletHoldings`), syncs it and **stops**.
- Done by ~05:00 for ~10 changed wallets; the 06:00 snapshot follows.

Code change this needs: the sync's body (inside `syncWalletHoldings`'
`after()`, `wallets/actions.ts` ~600–900) is extracted into a library
function `runWalletSync(walletId, db)` that both the Server Action (user's
session) and `sync-one` (service role, the wallet's owner checked) call —
no behavior change for manual Sync.

## Cost (per day, today's ~60 wallets: ~20 EVM, ~15 Solana, rest other)

| | Signal pass | Syncs (~5–10 changed + exchanges + weekly baseline) | Total | Limit |
|---|---|---|---|---|
| Supabase requests | ~5 (batched) | ~10–20 each → 100–250 | ~150–250 | ~5,000/day budget (3–5%) |
| Zerion | ~20 | ~5–10 (1 per EVM sync) | ~30 | 300/day |
| Helius | 0 (public RPC) | Solana syncs as today | — | 1M/month |
| Vercel invocations | ~20–60 ticks + ~15 sync-one | — | < 100 | 1M/30 days |
| Vercel CPU | — | ~15 syncs × ~1–2 s CPU | ~0.5 min | 4 h/30 days |
| Model tokens | — | — | 0 | — |

Versus syncing all 60 daily: ~4–6× fewer syncs.

**At 10× users (~600 wallets, ~200 EVM)**: the Zerion signal alone is 200
calls/day — over the free 300 with syncs and trading records. Then switch
the EVM signal to Alchemy (`alchemy_getAssetTransfers` from the stored
block, newest 1, per network the wallet has used — ~3–5 calls, ~150 CU
each) or a Zerion paid plan. The scheduler and Supabase load scale with
*changed* wallets, not all wallets.

## Safeguards (CLAUDE.md "build with bot protection")

- Cron-only: nothing user- or third-party-triggered starts it.
- Each wallet syncs at most once per morning; failures wait a day.
- Per-user ceiling: at most 100 wallet syncs per user per morning; past
  that, the rest wait (and a 🚨 Discord line) — a user adding hundreds of
  busy wallets can't consume the morning.
- Worst case if every signal says "changed": 60 syncs/day for the owner —
  the cost of "sync everything", still inside every limit above.
- One Discord line after the morning: wallets checked, changed, synced,
  failed, skipped (and why).

## What fails and how it shows

- Signal source down → wallets show "couldn't check today"; synced on the
  weekly baseline; Analytics marks nothing wrong (it simply has older data).
- A sync fails → the wallet keeps its rows (§4.3 carry-forward), status
  shows the error, retried tomorrow.
- The morning overruns 06:00 → the snapshot takes what's synced; the rest
  sync and appear in the next day's snapshot.
- pg_cron or the Vault secret missing → no ticks; the Discord line doesn't
  arrive (its absence is the alert).

## UI

- Wallets list "Synced" column: "5h ago" as now, plus "· no changes, checked
  2h ago" when the morning found nothing; "couldn't check" in amber.
- Wallet page: the same under Sync holdings.
- Analytics: unchanged — it just has fresher snapshots.
- The Auto-sync daily toggle's note changes to "Always synced each morning,
  even when no new transaction is seen (most wallets sync automatically when
  they change)".

## Data (one SQL change)

- `wallets.change_signal text`, `wallets.change_checked_at timestamptz`,
  `wallets.sync_due_at timestamptz` (+ index).
- pg_cron job `cryptoport-daily-sync` (04:00–05:54 every minute, the
  Postgres `where exists` due check), as Wallet Watch's.

## Phases (one commit each; stop for sign-off between)

1. **Extract `runWalletSync`** — manual Sync / Sync all unchanged (verify:
   sync 3 wallets of different chains by hand, compare rows before/after).
2. **Signals + dry run** — the SQL, the pure signal comparison
   (`syncSignals.ts` + tests), the adapters, and a read-only morning pass
   that only *reports* (Discord) which wallets it would sync; run 2–3
   mornings and check against what the owner actually did.
3. **Scheduler** — pg_cron, `sync-tick` / `sync-one`, lanes, per-user
   ceiling, UI status. Verify: a morning's Discord line, the 06:00 snapshot
   reflecting a wallet traded the day before, Supabase/Vercel/Zerion usage
   the next day vs the table above.

## Review (Fable, 2026-10-02) — changes adopted

Verdict: approach sound, not buildable as first written. Adopted:

1. **Service-role sync needs SQL.** `sync_auto_holdings`, `sync_cosmos_holdings`,
   `sync_defi_holdings`, `sync_exchange_holdings`, `replace_venue_holdings`
   raise "Not authorized" unless `user_id = auth.uid()`; the scheduler has no
   user. Each gets an `auth.role() = 'service_role'` branch (the user check
   stays) — SQL handed over before phase 1 ships (hold branch until run).
2. **`runWalletSync(db, wallet, mode)`** receives the client (no `userDb()`
   / cookies inside), takes the owner from `wallets.user_id`, and in
   scheduled mode skips `scheduleUserSnapshot` (the 06:00 snapshot covers it)
   and `revalidatePath`. Helpers typed to `userDb`'s client
   (`previousTokenContracts`, `saveDiscovery`, `withoutUntradableReceipts`,
   `markVenueActivity`) take the shared `Db` type (`positionsRefresh.ts`).
3. **Venues and DeFi have no wallet transaction.** Hyperliquid, Lighter,
   Aster, Polymarket (its proxy wallet), Jupiter Perps/Prediction, Kamino…
   change with no transaction from the wallet. So every morning, independent
   of the signal, `venuesToRefresh` + `refreshVenue` (positionsRefresh.ts,
   one call per venue) run for wallets with `wallet_venue_activity` in the
   last 30 days. Zerion DeFi accrual (vaults, lending) is covered by the
   weekly baseline — stated in the UI note.
4. **Solana signal = a holdings fingerprint, not the newest signature.** A
   plain transfer into an existing token account doesn't list the owner, so
   `getSignaturesForAddress(owner)` misses incoming tokens, and spam account
   creation flips busy wallets daily. Instead: `getTokenAccountsByOwner`
   (both token programs, amounts only via `dataSlice`) + `getBalance` on the
   free public RPC, hashed — exact, 3 calls.
5. **EVM signal:** Zerion transactions with `filter[trash]=only_non_trash`
   (airdrop spam would flag every wallet daily). Chains Zerion doesn't cover
   (diff `evmChains.ts` against `fetchZerionChainIdMap`: likely Manta,
   PulseChain, Merlin, Kava, Chiliz, DBK, Aurora) — a wallet holding on one
   also gets the weekly baseline.
6. **One rule for "never loop":** the claim sets `sync_due_at = tomorrow`
   in the same compare-and-set; a killed, failed or thrown sync simply waits
   a day. The pg_cron due check filters `active = true` and the syncable
   shape (`mode = 'auto' and address is not null` or `provider is not
   null`). The signal pass reads *all* candidates (a new wallet's
   `sync_due_at` is null) and the first-tick marker is written *after* it.
7. **Lanes shared with the user's own syncs** (04:00 UTC is 21:00 Pacific):
   the tick counts any wallet syncing in the last few minutes, user-started
   included, before filling a lane. The Sunday 05:00 token-registry cron sits
   inside the window — the window becomes 04:00–05:00 on Sundays… simpler:
   the tick skips while `token_registry_state` is refreshing.
8. **Safeguards on the signal pass too:** per user at most 100 wallets
   checked a morning; an app-wide daily Zerion signal budget (150) — overflow
   goes to the weekly baseline; a wallet-count threshold in `abuseGuard.ts`.
9. **Costs restated:** ticks ~3 requests a minute while due (~135 for a
   45-minute morning); a sync ~20–30 requests; CPU from
   `wallets.last_sync_duration_ms`. Single-call chains (BTC single address,
   ADA — Koios `account_info` is the sync) cost as much to check as to sync:
   those just sync weekly + on demand; the signal pays on EVM, Solana,
   Cosmos, xpub.

Also adopted:
- **Phase 0 (now, independent):** Analytics treats a wallet not synced
  within the window as *unknown* — "not synced since …", never a silent 0 in
  "everything else" (§4.1).
- **One daily mechanism:** the Refresh-prices `dueForAutoSync` path is
  retired once the morning sync ships; "Auto-sync daily" becomes "always
  sync each morning".
- **Users not signed in for 14 days are skipped** (the biggest saver at 10×).
- The arithmetic, for the record: sync-all-daily ≈ 60 × ~25 = 1,500 Supabase
  requests/day (30% of budget) and ~5 CPU-hours/month (Hobby: 4) — signals
  are what make it affordable.

### Revised phases
0. Analytics: stale wallets shown as unknown ("not synced since …").
1. SQL (service-role branches) + `runWalletSync` extraction; manual Sync
   unchanged (verify by hand on 3 chains), the service path verified after
   the SQL runs.
2. Signals (Solana fingerprint, Zerion non-trash, BTC/ADA weekly) + venue
   refresh plan, **report-only** for 2–3 mornings: Discord lists what it
   would sync; a sample is synced and diffed to prove the signals.
3. Scheduler (pg_cron, `sync-tick` / `sync-one`, lanes shared with user
   syncs, caps), UI status, retire the Refresh-prices path.

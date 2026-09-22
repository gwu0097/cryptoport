# Data sources — live-verified 2026-09-22

Every endpoint below was hit with a real `curl` call during this recon pass (not taken from docs alone). Raw sample responses are trimmed for readability; full raw JSON captured during verification is available on request.

---

## 1. DefiLlama — protocols list

- **URL**: `https://api.llama.fi/protocols`
- **Auth**: none
- **Rate limits**: no documented hard limit; DefiLlama's own docs ask for "reasonable use." Not load-tested to a limit this session — treat as free but cap concurrency defensively (same `mapWithConcurrency` discipline cryptoport already uses for CoinGecko/Coinbase).
- **Free tier**: yes, fully free, no key.
- **Fields we'll use**: `name`, `gecko_id`, `category`, `tvl`, `mcap`, `chains`, `symbol`.
- **Live result**: HTTP 200, 8,891,648 bytes, **8,325 protocols**. Sample (protocol with `gecko_id` present):
  ```json
  { "name": "OKX", "gecko_id": "okb", "category": "CEX",
    "tvl": 32316141468.40, "mcap": 2541453453.01,
    "chains": ["Ethereum","Bitcoin","X Layer","Solana", "..."] }
  ```
- **Caveat**: `mcap` here is DefiLlama's own figure, not CoinGecko's — this is exactly the kind of field the spec's conflict-detection rule (§4 in the build prompt) needs to check against CoinGecko's `market_cap` for the same `gecko_id`.

## 2. DefiLlama — fees overview

- **URL**: `https://api.llama.fi/overview/fees` (add `?dataType=dailyRevenue` or `?dataType=dailyHoldersRevenue` to change what the totals mean)
- **Auth**: none
- **Rate limits**: same as above (unauthenticated, no documented ceiling).
- **Free tier**: yes.
- **Fields we'll use**: per-protocol `total24h`, `total7d`, `total30d`, `total1y`, `category`, `name`/`slug`/`gecko_id` — **the `dataType` query param is load-bearing, not cosmetic**: verified live that switching it actually changes the number, it isn't just a display label.
- **Live result — Aave, three `dataType` values, 2026-09-22**:
  | dataType | total24h | total30d |
  |---|---|---|
  | `dailyFees` | $1,347,376 | $35,987,099 |
  | `dailyRevenue` | $172,934 | $5,086,396 |
  | `dailyHoldersRevenue` | $0 | $0 |
- **Important nuance for Phase 2's null-handling rule**: DefiLlama returns a literal `0` for `dailyHoldersRevenue` when a protocol has **no holder-revenue mechanism at all** (e.g. Aave today — no fee switch to token holders) — it does not omit the field or return `null`. That `0` is a real, correct data point ("this protocol captures nothing for holders"), not a missing value. But some protocols DefiLlama simply hasn't wired up holders-revenue tracking for at all, and those may also come back as `0`. **We cannot tell "confirmed zero capture" apart from "not tracked" from this field alone** — Phase 1's fetcher needs to decide how to disambiguate this (e.g., cross-check against the protocol's fee methodology text, or treat all `dailyHoldersRevenue: 0` as `null` pending manual spot-checks of a few known-zero-capture protocols). Flagging as an open question for Phase 0 sign-off rather than deciding unilaterally, since it directly affects the `capture` metric's "never 0 by default" rule.

## 3. DefiLlama — per-protocol fee summary

- **URL**: `https://api.llama.fi/summary/fees/{protocol-slug}` (e.g. `/summary/fees/aave`), same `dataType` param as #2
- **Auth**: none
- **Free tier**: yes.
- **Fields we'll use**: `total24h`, `total30d`, `total7d`, `total1y`, `annualized1y`, `gecko_id`, `category`, `chains`.
- **Live result**: HTTP 200, 687,450 bytes for `aave`. Full field list confirmed live: `address, annualized1y, audit_links, audits, breakdownMethodology, category, chainBreakdown, chains, ..., gecko_id, ..., total24h, total30d, total7d, totalAllTime, ...`.
- **Methodology field — checked and empty**: `methodology`, `methodologyURL`, and `breakdownMethodology` were all `null` in the live response for all three protocol types tested (Aave/lending, Uniswap/DEX, Hyperliquid/perps). DefiLlama does not expose machine-readable per-protocol methodology text via this endpoint — see the Token Terminal mapping in `PHASE_0.md` §5 for how this affects the fees/revenue/holders-revenue definitional confidence, and decision #3 in that file for the resulting recommendation (a hand-curated config, not a live-fetched field).
- **Historical depth — live-tested**: `totalDataChart` on the `aave` response returns **2,119 daily rows**, earliest 2020-12-04 (epoch `1607040000`), latest today — just under 5 years of free daily fee/revenue history for this protocol. This is far deeper than CoinGecko's 365-day price-history ceiling and is the more generous of the two for backtesting purposes — but see `PHASE_0.md` §6 for why "how deep the chart goes today" isn't the same question as "was this true point-in-time history."

## 4. DefiLlama — stablecoins

- **URL (snapshot)**: `https://stablecoins.llama.fi/stablecoins?includePrices=false`
- **URL (history, per-stablecoin)**: `https://stablecoins.llama.fi/stablecoincharts/all?stablecoin={id}`
- **Auth**: none. **Free tier**: yes.
- **Fields we'll use**: `circulating.peggedUSD`, `circulatingPrevDay`, `circulatingPrevWeek`, `circulatingPrevMonth` (snapshot endpoint already gives us prev-day/week/month deltas for free, no need to build our own 30d trend for *total* stablecoin supply); `totalCirculatingUSD` per day (history endpoint) for the regime engine's "total stablecoin supply 30d % change" input.
- **Live result**: snapshot — 427 pegged assets, e.g. Tether: `circulating: $183.49B`, `circulatingPrevMonth: $183.18B`. History — 3,220 daily rows for USDT-only chart id `1`, most recent: `totalCirculatingUSD: $183.48B` on epoch day `1790035200`.
- **Caveat**: the history endpoint is per-stablecoin (`?stablecoin={id}`), not "all stablecoins combined" — for the regime engine's aggregate figure, either sum across the handful of major stablecoins (USDT/USDC/DAI/etc., which the spec's regime rules care about) or just use the snapshot endpoint's already-aggregated `circulating`/`circulatingPrevMonth` fields summed across `peggedAssets` — the snapshot endpoint is simpler and sufficient for a 30d % change figure; the history endpoint would only matter for storing our own daily trend if we ever want finer granularity than DefiLlama's own prev-day/week/month deltas.

## 5. CoinGecko — `/coins/markets` and `/global`

- **URL**: `https://api.coingecko.com/api/v3/global`, `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=...&price_change_percentage=24h,7d`
- **Auth**: **required for reliable use** — `x-cg-demo-api-key` header. cryptoport already has a working free Demo key (`COINGECKO_API_KEY` in `.env.local`, wired in `src/lib/adapters/coingecko.ts`) — reused directly for this verification, not a new key.
- **Rate limits**: CoinGecko's own documented Demo-tier limits are 30 calls/min and 10,000 calls/month — cited from CoinGecko's public docs, not independently pushed to the edge this session (cryptoport's existing adapter already respects this defensively via `mapWithConcurrency` + backoff, same pattern to reuse here).
- **Free tier**: yes (Demo plan, the same one cryptoport already uses).
- **Fields we'll use**: `current_price`, `market_cap`, `fully_diluted_valuation`, `circulating_supply`, `total_supply`, `max_supply`, `price_change_percentage_24h/7d`, plus `/global`'s `market_cap_percentage.btc` (dominance) and `total_market_cap.usd`.
- **Live result**: `/global` → BTC dominance 58.90%, ETH dominance 11.38%, total mcap $2.945T. `/coins/markets?ids=bitcoin` → full row confirmed, all fields present including `fully_diluted_valuation: 1,735,818,043,175`.
- **Historical depth — live-tested, hard limit confirmed**: `/coins/{id}/market_chart?days=365` → HTTP 200, 366 daily rows, 2025-09-23 through today. `days=366` → **HTTP 401**, exact error: `"Your request exceeds the allowed time range. Public API users are limited to querying historical data within the past 365 days."` This is a hard, enforced ceiling on the free/demo tier, not a soft default — confirmed by testing the boundary directly, not read from docs. Directly limits Phase 4's price-based backtest (`mom_3w`, `mom_12w`, `beta_btc`) to whatever we've snapshotted ourselves going forward, plus at most 365 days retroactively, once.

## 6. Hyperliquid — info API (funding + open interest)

- **URL**: `https://api.hyperliquid.xyz/info`, POST, body `{"type":"metaAndAssetCtxs"}`
- **Auth**: none.
- **Rate limits**: Hyperliquid documents a weight-based IP rate limit for `/info` (generous for this use case — one call returns funding/OI for every listed perp at once, so the screener only needs this once per run, not once per asset). Not independently load-tested to the documented ceiling this session.
- **Free tier**: yes, fully free, no key.
- **Fields we'll use**: `funding` (hourly funding rate), `openInterest`, `dayNtlVlm` (24h notional volume), `markPx`/`oraclePx`.
- **Live result**: HTTP 200, 72,687 bytes. BTC: funding `0.0000125` (hourly), OI `46,927.6` BTC, 24h volume `$3.29B`. ETH: funding `0.0000125`, OI `1,144,152.9` ETH, 24h volume `$1.34B`.
- **Note**: one call returns the *entire* asset universe's contexts in a single array — cheap to poll, no per-asset request needed even if we later want funding/OI for more than just BTC/ETH.

## 7a. Token Terminal — v2 addition, checked live

- **URL**: `https://api.tokenterminal.com/v2/projects`
- **Auth**: **required** — live-tested, `HTTP 403 {"message":"invalid token"}` on an unauthenticated call. No anonymous/free tier exists.
- **Free tier**: **no.** Confirmed paid/subscription-gated, not assumed from pricing-page copy.
- **Docs**: their own docs site (`tokenterminal.com/docs`) doesn't surface a plain-text glossary of "fees"/"revenue"/"earnings" at the URLs checked (`/docs/catalog/index`, `/docs/catalog/financial-statements` → 404) — several fetch attempts hit dead links or nav-only pages. The Token Terminal definitions used in `PHASE_0.md` §5's mapping table are the well-established, widely-cited industry-standard versions of these terms, not a definition independently confirmed by fetching Token Terminal's own glossary text this session — flagged honestly rather than overstated.
- **Conclusion**: no free workaround needed here specifically, since v2's design already routes around this (DefiLlama for fees/revenue, with earnings left `null` where DefiLlama has no equivalent — see `PHASE_0.md` §5).

## 7. Token unlocks / emissions — investigated, NOT built (per instruction)

- **DefiLlama `/emissions` and `/emission/{protocol}`**: **live-tested — confirmed Pro-only.** Both returned `HTTP 402 Upgrade to the paid API plan at https://defillama.com/subscription`. This settles the open question from the build prompt: the free DefiLlama tier does not include forward-looking unlock/emissions data, despite `defillama.com/unlocks` displaying it on their own website (their frontend almost certainly uses their own paid key server-side — a common "free to browse, paid to integrate" pattern, not evidence of a public free path).
- **Alternatives surveyed, not live-tested** (no free, keyless public API found for any of them):
  - **Tokenomist.ai** — offers API access but gated behind a free-trial/signup flow, not an open public endpoint; unclear if a trial converts to a sustainable free tier.
  - **CryptoRank.io** — has vesting-schedule data on its site and an API, but the API is a paid product per its own pricing page.
  - **CoinGlass** — unlock calendar is a web page (`coinglass.com/token-unlock`), no documented public API found for it.
  - **CoinGecko** — does not expose vesting/unlock data anywhere in its public API surface (confirmed by checking the existing cryptoport CoinGecko adapter's field usage and CoinGecko's own API reference — no unlock/vesting endpoint exists at any tier).
- **Recommended free workaround** (this is the one the build prompt itself invited — "such as snapshotting data daily and building my own history"): since `circulating_supply` and `total_supply`/`max_supply` are already free and reliable from CoinGecko (#5 above), a **daily snapshot of circulating supply** lets us detect a real unlock *after it happens* (a step-change in circulating supply week over week) — a **trailing/retrospective** signal, not the **forward-looking "unlocks in the next 90 days"** the kill-filter spec assumes. This is a materially weaker signal than a real unlock calendar (it can't warn ahead of a known cliff, only flag one that already landed), and it takes weeks of accumulated snapshots before it's useful at all (no unlock history = no trend to detect yet, same "insufficient history" honesty the spec already builds in for Phase 5's calibration report).
- **Open decision for Phase 0 sign-off** (do not build until you choose): (a) skip the unlock-overhang gate entirely in v1 and mark it "not scored — no free forward-looking data source," or (b) build the retrospective daily-supply-snapshot proxy now, accepting it detects unlocks only after they land, or (c) revisit if you're later willing to pay for one paid source specifically for this one field (Tokenomist/CryptoRank) while keeping everything else free.

import "server-only";
import { cache } from "react";
import { coingeckoFetch, COINGECKO_HAS_KEY } from "./coingeckoFetch";
import { createTtlCache, type Fetched } from "../ttlCache";
import { EVM_CHAINS } from "./evmChains";
import { serviceDb } from "../supabase";
import { upsertTokenRegistry } from "./tokenRegistry";
import { NON_EVM_PLATFORM_IDS, NATIVE_ICON_CHAINS } from "./coingeckoIds";

const API_BASE = "https://api.coingecko.com/api/v3";

// Optional: without a key, CoinGecko's public tier still works (verified —
// coins/list and simple/token_price both respond with no auth), but caps
// simple/token_price at 1 contract address per call, which is slow for a
// chain with 100+ registered tokens. A free Demo key (no payment) raises
// that batch size substantially. Falls back to single-address calls when
// unset, so this works out of the box either way. Keys (primary + backup)
// are handled in coingeckoFetch.ts.
const PRICE_BATCH_SIZE = COINGECKO_HAS_KEY ? 100 : 1;

interface CoinListEntry {
  id: string;
  symbol: string;
  platforms?: Record<string, string>;
}

interface AssetPlatform {
  id: string;
  image?: { small?: string };
}

/**
 * Refreshes cryptoport.token_registry from CoinGecko's coins/list — one
 * call covers every chain in EVM_CHAINS (and every chain CoinGecko knows
 * about; this only keeps the ones matching a configured platform id).
 * Upsert, not replace: a token that drops out of a later CoinGecko listing
 * doesn't lose its already-known decimals.
 *
 * Also refreshes cryptoport.chain_icons from the same CoinGecko
 * asset_platforms endpoint this app already trusts for coingeckoPlatform /
 * nativeCoingeckoId (see evmChains.ts) — every chain currently configured
 * has a real logo there (verified against all 30 + solana + hyperliquid),
 * keyed by the same `coingeckoPlatform` id already stored per chain. This
 * is what makes chain icons keep working without a hand-maintained URL
 * list: add a chain to EVM_CHAINS, run this once, its icon is there too.
 */
export async function refreshTokenRegistry(): Promise<{ chainId: string; count: number }[]> {
  const [coinsRes, platformsRes] = await Promise.all([
    coingeckoFetch(`${API_BASE}/coins/list?include_platform=true`),
    coingeckoFetch(`${API_BASE}/asset_platforms`),
  ]);
  if (!coinsRes.ok) throw new Error(`CoinGecko coins/list failed: HTTP ${coinsRes.status}`);
  if (!platformsRes.ok) throw new Error(`CoinGecko asset_platforms failed: HTTP ${platformsRes.status}`);
  const coins: CoinListEntry[] = await coinsRes.json();
  const platforms: AssetPlatform[] = await platformsRes.json();
  const platformImages = new Map(
    platforms.filter((p) => p.image?.small).map((p) => [p.id, p.image!.small!]),
  );

  const results: { chainId: string; count: number }[] = [];

  for (const chain of EVM_CHAINS) {
    const rows = coins
      .filter((c) => chain.coingeckoPlatform && c.platforms?.[chain.coingeckoPlatform])
      .map((c) => ({
        chain_id: chain.id,
        contract: c.platforms![chain.coingeckoPlatform!].toLowerCase(),
        symbol: c.symbol.toUpperCase(),
        coingecko_id: c.id,
        updated_at: new Date().toISOString(),
      }))
      .filter((r) => r.contract && r.contract !== "");

    await upsertTokenRegistry(rows);

    results.push({ chainId: chain.id, count: rows.length });
  }

  // Same coins/list response, one more platform extracted from it — a
  // mint -> coingecko_id cache for Solana SPL tokens, same shape as the
  // EVM loop above. This is what gives a CoinGecko-listed Solana mint a
  // CoinGecko-id price_key (assetIdentity.ts's resolvePriceKey), so it's
  // priced in assetPrices.ts's coingecko lane with its full 1h/7d/30d
  // change instead of as a `jup:<mint>` key.
  //
  // Written under a single chain_id ("solana"), not per holding.chain
  // value ("solana" vs "solana-defi" both mean the same underlying
  // Solana platform) — the read side (assetIdentity.ts's contractKey)
  // does key by chain, but maps "solana-defi" to "solana" first
  // (REGISTRY_CHAIN), so one canonical entry per mint is enough
  // regardless of which app-internal chain label a given holding carries.
  //
  // .toLowerCase() here is purely an internal DB-key convention, matching
  // every other token_registry.contract value in this table — it's never
  // sent back to an external API expecting the mint's real, case-
  // sensitive base58 form (Solana addresses ARE case-sensitive, unlike
  // EVM hex), only used to look itself back up via the exact same
  // lowercasing this table's read side already applies everywhere.
  // Solana and Sui: the same contract -> coin map for chains outside
  // EVM_CHAINS (Sui added 2026-09-25 so Sui coin types get a CoinGecko id —
  // docs/pricing/PLAN.md; a Sui "contract" is its coin type, e.g.
  // 0x…::hasui::HASUI).
  for (const chainId of ["solana", "sui"]) {
    const platform = NON_EVM_PLATFORM_IDS[chainId];
    const rows = coins
      .filter((c) => c.platforms?.[platform])
      .map((c) => ({
        chain_id: chainId,
        contract: c.platforms![platform].toLowerCase(),
        symbol: c.symbol.toUpperCase(),
        coingecko_id: c.id,
        updated_at: new Date().toISOString(),
      }))
      .filter((r) => r.contract && r.contract !== "");

    await upsertTokenRegistry(rows);

    results.push({ chainId, count: rows.length });
  }

  const chainIconRows = [
    ...EVM_CHAINS.filter((c) => c.coingeckoPlatform).map((c) => ({ chain_id: c.id, platformId: c.coingeckoPlatform! })),
    ...Object.entries(NON_EVM_PLATFORM_IDS).map(([chainId, platformId]) => ({ chain_id: chainId, platformId })),
  ]
    .map((r) => ({ chain_id: r.chain_id, image_url: platformImages.get(r.platformId) }))
    .filter((r): r is { chain_id: string; image_url: string } => Boolean(r.image_url));

  // Chains with no CoinGecko asset_platforms entry (not smart-contract
  // platforms — no concept of "tokens on this chain" in CoinGecko's model)
  // — their own native coin's image doubles as the chain-brand icon
  // instead. Extend this as new non-platform chains get adapters (started
  // with just Bitcoin; Cosmos SDK chains added alongside cosmos.ts).
  const nativeIconImages = await fetchTokenImages(Object.values(NATIVE_ICON_CHAINS)).catch(
    () => new Map<string, string>(),
  );
  for (const [chainId, coingeckoId] of Object.entries(NATIVE_ICON_CHAINS)) {
    const image = nativeIconImages.get(coingeckoId);
    if (image) chainIconRows.push({ chain_id: chainId, image_url: image });
  }

  // One row per chain: a chain can be both a CoinGecko platform and a
  // native-icon chain (Sui, since 2026-09-25), and one upsert can't touch the
  // same row twice ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time"). The native coin's icon (pushed last) wins.
  const iconByChain = new Map(chainIconRows.map((r) => [r.chain_id, r]));
  const uniqueIconRows = [...iconByChain.values()];
  if (uniqueIconRows.length > 0) {
    const { error } = await serviceDb().from("chain_icons").upsert(uniqueIconRows, { onConflict: "chain_id" });
    if (error) throw new Error(`Failed to upsert chain_icons: ${error.message}`);
  }

  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export interface CoingeckoPrice {
  usd: number;
  /** 24h % change, e.g. 1.81 for +1.81% — free in the same response via
   * include_24hr_change=true. Null when CoinGecko has no 24h stats for this
   * asset, which doesn't block the price itself from being used. */
  change24h: number | null;
  /** Free in the same response via include_market_cap=true — no extra call
   * over what this function already makes. Null when CoinGecko has no
   * market cap for this asset (a token too new/thin for it to compute). */
  marketCap: number | null;
}

/** contract (lowercase) -> {usd, change24h, marketCap}, only for contracts CoinGecko can price. */
export async function fetchTokenPrices(
  coingeckoPlatform: string,
  contracts: string[],
): Promise<Map<string, CoingeckoPrice>> {
  const prices = new Map<string, CoingeckoPrice>();
  if (contracts.length === 0) return prices;

  for (const batch of chunk(contracts, PRICE_BATCH_SIZE)) {
    const url = `${API_BASE}/simple/token_price/${coingeckoPlatform}?contract_addresses=${batch.join(",")}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;
    // Longer backoff (5 tries, 6s base): two EVM wallets syncing at once
    // outran the per-minute limit with the default 3 tries (2026-09-25).
    const res = await coingeckoFetch(url, MARKETS_FETCH_OPTS);
    if (!res.ok) throw new Error(`CoinGecko token_price(${coingeckoPlatform}) failed: HTTP ${res.status}`);
    const body: Record<string, { usd?: number; usd_24h_change?: number; usd_market_cap?: number }> =
      await res.json();
    for (const [contract, price] of Object.entries(body)) {
      if (typeof price.usd === "number") {
        prices.set(contract.toLowerCase(), {
          usd: price.usd,
          change24h: typeof price.usd_24h_change === "number" ? price.usd_24h_change : null,
          marketCap: typeof price.usd_market_cap === "number" ? price.usd_market_cap : null,
        });
      }
    }
  }

  return prices;
}

export interface CoingeckoMarketStats extends CoingeckoPrice {
  /** 1h/7d/30d % change — live-verified (2026-09) that only /coins/markets
   * gives these (via price_change_percentage=1h,7d,30d), not
   * simple/price or simple/token_price, which cap out at 24h. Null when
   * CoinGecko has no data for that window (same "don't distinguish why"
   * reasoning as change24h/marketCap). */
  change1h: number | null;
  change7d: number | null;
  change30d: number | null;
  /** 24h trading volume in USD across every venue CoinGecko tracks — the
   * tradability signal (receiptDedupe.ts). Null when not reported. */
  volume24h: number | null;
  /** Free in the same /coins/markets response — display info for the
   * `assets` table (docs/pricing/PLAN.md). */
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
}

const MARKETS_BATCH_SIZE = 250; // coins/markets' own per-call ids cap

/** coingecko-id -> full market stats (price, 1h/24h/7d/30d change, market
 * cap) via /coins/markets — a superset of what simple/price gives. This is
 * assetPrices.ts's coingecko lane: every CoinGecko-id price_key (natives
 * like BTC/ETH/SOL/ADA, and contract tokens, whose id token_registry
 * resolves from the coins/list import) is priced here, which is how they
 * all get 1h/7d/30d change — simple/token_price's contract-address lookup
 * (fetchTokenPrices) is 24h-only (confirmed it silently ignores
 * price_change_percentage). */
export async function fetchMarketStatsByIds(coingeckoIds: string[]): Promise<Map<string, CoingeckoMarketStats>> {
  const stats = new Map<string, CoingeckoMarketStats>();
  if (coingeckoIds.length === 0) return stats;

  for (const batch of chunk(coingeckoIds, MARKETS_BATCH_SIZE)) {
    // "24h" has to be listed explicitly here too — live-verified that
    // price_change_percentage_24h_in_currency is only present in the
    // response when its own window is named in this param; omitting it
    // (only requesting 1h,7d,30d) silently dropped change24h to null even
    // though the plain, non-"_in_currency" field was still there. Reading
    // the "_in_currency" variant uniformly across all 4 windows (rather
    // than mixing in the base field for just this one) keeps them on the
    // same basis, even though both should be equivalent here (vs_currency
    // is already fixed to usd for the whole call).
    // per_page: /coins/markets returns 100 rows by default even for 250 ids —
    // without it a batch over 100 silently dropped its smallest coins
    // (2026-09-25).
    const url = `${API_BASE}/coins/markets?vs_currency=usd&ids=${batch.join(",")}&per_page=${batch.length}&price_change_percentage=1h,24h,7d,30d&sparkline=false`;
    const res = await coingeckoFetch(url);
    if (!res.ok) throw new Error(`CoinGecko coins/markets failed: HTTP ${res.status}`);
    const body: {
      id: string;
      symbol?: string;
      name?: string;
      image?: string;
      current_price?: number;
      price_change_percentage_1h_in_currency?: number;
      price_change_percentage_24h_in_currency?: number;
      price_change_percentage_7d_in_currency?: number;
      price_change_percentage_30d_in_currency?: number;
      market_cap?: number;
      total_volume?: number;
    }[] = await res.json();
    for (const coin of body) {
      if (typeof coin.current_price === "number") {
        stats.set(coin.id, {
          symbol: coin.symbol?.toUpperCase() ?? null,
          name: coin.name ?? null,
          image: coin.image ?? null,
          usd: coin.current_price,
          change1h: typeof coin.price_change_percentage_1h_in_currency === "number"
            ? coin.price_change_percentage_1h_in_currency
            : null,
          change24h: typeof coin.price_change_percentage_24h_in_currency === "number"
            ? coin.price_change_percentage_24h_in_currency
            : null,
          change7d: typeof coin.price_change_percentage_7d_in_currency === "number"
            ? coin.price_change_percentage_7d_in_currency
            : null,
          change30d: typeof coin.price_change_percentage_30d_in_currency === "number"
            ? coin.price_change_percentage_30d_in_currency
            : null,
          marketCap: typeof coin.market_cap === "number" ? coin.market_cap : null,
          volume24h: typeof coin.total_volume === "number" ? coin.total_volume : null,
        });
      }
    }
  }

  return stats;
}

/** coingecko_id -> logo URL, for whichever of the given ids CoinGecko has
 * an image for — cached for good in coin_cache (a coin's logo doesn't
 * change). Native-coin logos used to be fetched fresh on every wallet sync
 * (BTC, ADA, NEAR, ... and every EVM chain's native): one CoinGecko call
 * per sync for a picture that never changes (2026-09-25). Only ids the cache
 * lacks are fetched; a cache read/write failure just means fetching. */
export async function fetchTokenImages(coingeckoIds: string[]): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const distinct = [...new Set(coingeckoIds)];
  if (distinct.length === 0) return images;

  const db = serviceDb();
  const { data } = await db.from("coin_cache").select("coingecko_id, image_url").in("coingecko_id", distinct).not("image_url", "is", null);
  for (const r of (data ?? []) as { coingecko_id: string; image_url: string }[]) images.set(r.coingecko_id, r.image_url);
  const missing = distinct.filter((id) => !images.has(id));

  const fetched: { coingecko_id: string; image_url: string; updated_at: string }[] = [];
  for (const batch of chunk(missing, MARKETS_BATCH_SIZE)) {
    const url = `${API_BASE}/coins/markets?vs_currency=usd&ids=${batch.join(",")}&per_page=${batch.length}&sparkline=false`; // per_page: see fetchMarketStatsByIds
    const res = await coingeckoFetch(url);
    if (!res.ok) throw new Error(`CoinGecko coins/markets failed: HTTP ${res.status}`);
    const body: { id: string; image?: string }[] = await res.json();
    for (const coin of body) {
      if (!coin.image) continue;
      images.set(coin.id, coin.image);
      fetched.push({ coingecko_id: coin.id, image_url: coin.image, updated_at: new Date().toISOString() });
    }
  }
  if (fetched.length > 0) {
    const { error } = await db.from("coin_cache").upsert(fetched, { onConflict: "coingecko_id" });
    if (error) console.warn(`[coingecko] coin_cache image save failed: ${error.message}`);
  }
  return images;
}

/**
 * ticker symbol -> logo URL, via coins/markets' `symbols` param (live-
 * verified: it resolves each symbol to its single highest-market-cap-rank
 * match, e.g. "eth" -> Ethereum, never a list of every coin sharing that
 * symbol the way /search does — exactly one row per symbol, which is what
 * an icon lookup needs and searchCoins deliberately doesn't give). Icon-only
 * — unlike every price-bearing lookup in this file, a wrong symbol match
 * here is a cosmetic risk, not a valuation one (see resolveTickerIcons, the
 * only caller: these holdings are priced by their price_key, never by this
 * lookup — it only ever touches `icon_url`). Callers
 * should still skip fiat codes (USD, EUR, ...) — CoinGecko's "best match"
 * for a fiat symbol is some unrelated obscure coin that happens to share it,
 * not a real crypto icon.
 */
async function fetchTokenImagesBySymbol(symbols: string[]): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const distinct = [...new Set(symbols.map((s) => s.toLowerCase()))];
  if (distinct.length === 0) return images;

  for (const batch of chunk(distinct, MARKETS_BATCH_SIZE)) {
    const url = `${API_BASE}/coins/markets?vs_currency=usd&symbols=${batch.join(",")}`;
    const res = await coingeckoFetch(url);
    if (!res.ok) throw new Error(`CoinGecko coins/markets(symbols) failed: HTTP ${res.status}`);
    const body: { symbol: string; image?: string }[] = await res.json();
    for (const coin of body) {
      if (coin.image) images.set(coin.symbol.toUpperCase(), coin.image);
    }
  }

  return images;
}

/**
 * ticker (uppercase) -> logo URL, cached in cryptoport.ticker_icons — the
 * ticker-keyed sibling of token_registry.image_url (that one's fetched at
 * most once per contract, ever; this is the same idea for a bare symbol).
 * A ticker alone can collide across unrelated assets in a way a
 * chain+contract pair never does, so this is only as safe as the caller's
 * own ticker list — today that's exclusively a connected exchange's own
 * currency codes (coinbaseAdvancedTrade.ts), never an arbitrary/user-typed
 * ticker, which is exactly the case fetchTokenImagesBySymbol's own doc
 * comment already flags as icon-only/cosmetic risk.
 */
// A symbol CoinGecko has no coin for is remembered too (image_url null), so
// it isn't searched again on every sync — two Hyperliquid spot tokens (LQNA,
// LICKO) cost a CoinGecko call on every sync of one wallet (2026-09-26).
// Checked again after this long, in case CoinGecko lists it later.
const NO_ICON_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

export async function resolveTickerIcons(tickers: string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(tickers.map((t) => t.toUpperCase()))];
  const icons = new Map<string, string>();
  if (distinct.length === 0) return icons;

  const { data, error } = await serviceDb().from("ticker_icons").select("ticker, image_url, updated_at").in("ticker", distinct);
  if (error) throw new Error(`Failed to load ticker_icons: ${error.message}`);
  const knownNone = new Set<string>();
  for (const row of data as { ticker: string; image_url: string | null; updated_at: string }[]) {
    if (row.image_url) icons.set(row.ticker, row.image_url);
    else if (Date.now() - Date.parse(row.updated_at) < NO_ICON_RECHECK_MS) knownNone.add(row.ticker);
  }

  const missing = distinct.filter((t) => !icons.has(t) && !knownNone.has(t));
  if (missing.length > 0) {
    const fetched = await fetchTokenImagesBySymbol(missing);
    if (fetched.size > 0) {
      const rows = [...fetched].map(([ticker, image_url]) => ({ ticker, image_url, updated_at: new Date().toISOString() }));
      const { error: upsertError } = await serviceDb().from("ticker_icons").upsert(rows, { onConflict: "ticker" });
      if (upsertError) throw new Error(`Failed to cache ticker_icons: ${upsertError.message}`);
      for (const [ticker, url] of fetched) icons.set(ticker, url);
    }
    const none = missing.filter((t) => !fetched.has(t)).map((ticker) => ({ ticker, image_url: null, updated_at: new Date().toISOString() }));
    if (none.length > 0) {
      // Best-effort: a failure only means asking again next time.
      const { error: noneError } = await serviceDb().from("ticker_icons").upsert(none, { onConflict: "ticker" });
      if (noneError) console.warn(`[icons] couldn't remember ${none.length} symbol(s) without a logo: ${noneError.message}`);
    }
  }

  return icons;
}

// Trend Finder's /coins/markets calls (top-by-market-cap, single-id lookup)
// need much more spacing than fetchWithRetry's defaults — live-verified
// this session that this endpoint family 429s at default spacing and
// needed ~5-6s to clear reliably on CoinGecko's anonymous tier.
const MARKETS_FETCH_OPTS = { attempts: 5, baseDelayMs: 6000 };

// Price-bearing responses (/coins/markets, /coins/categories) are reused for
// PRICE_TTL_MS across requests: repeat views of the same coin within a minute
// share one response instead of each spending a credit (the primary key is
// capped until 10-01; the backup is paying). Identical in-flight requests
// share one fetch too. Every row carries `fetchedAtMs`, the time CoinGecko
// actually answered, so pages caption its real age ("priced 40s ago") — a
// cached price is never presented as live. Failed responses aren't cached.
// Per request, React cache() also dedupes repeat calls with the same args.
const PRICE_TTL_MS = 60_000;
const priceCache = createTtlCache<unknown>(PRICE_TTL_MS);
const searchCache = createTtlCache<{
  coins?: { id: string; symbol: string; name: string; thumb?: string; market_cap_rank?: number | null }[];
}>(PRICE_TTL_MS);

function cachedMarketsJson<T>(url: string, label: string): Promise<Fetched<T>> {
  return priceCache.get(url, async () => {
    const res = await coingeckoFetch(url, MARKETS_FETCH_OPTS);
    if (!res.ok) throw new Error(`CoinGecko ${label} failed: HTTP ${res.status}`);
    return res.json();
  }) as Promise<Fetched<T>>;
}

export interface MarketDataRow {
  id: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  price: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  marketCap: number | null;
  /** Fully diluted valuation, circulating/total/max supply, and 24h volume
   * — all present in the same /coins/markets response every row here
   * already comes from, just unparsed until the screener needed them
   * (src/lib/screener/adapters/coingecko.ts). Added here rather than as a
   * separate screener-only fetcher since it's the same endpoint, same
   * call, zero extra cost — CLAUDE.md's "don't duplicate a second near-
   * identical adapter" rule. Existing callers are unaffected (additive
   * fields only). */
  fdv: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  volume24h: number | null;
  /** When CoinGecko actually returned this row (it may come from the 60s price cache). */
  fetchedAtMs: number;
}

export interface CategoryStat {
  id: string;
  name: string;
  marketCap: number | null;
  marketCapChange24h: number | null;
  /** When CoinGecko actually returned this row (it may come from the 60s price cache). */
  fetchedAtMs: number;
}

/**
 * Every CoinGecko category and its total market cap/24h change — one call,
 * ~765 rows. Trend Finder uses it to resolve the seed's functional category
 * names (categoryFilter.ts) to real category ids before fetching members.
 * market_cap_change_24h is live financial data: reused only within the 60s
 * price cache, and every row carries its real fetch time for the caption.
 */
export const fetchCategoryStats = cache(async (): Promise<CategoryStat[]> => {
  const { value: body, fetchedAtMs } = await cachedMarketsJson<
    { id: string; name: string; market_cap?: number | null; market_cap_change_24h?: number | null }[]
  >(`${API_BASE}/coins/categories`, "coins/categories");
  return body.map((c) => ({
    id: c.id,
    name: c.name,
    marketCap: typeof c.market_cap === "number" ? c.market_cap : null,
    marketCapChange24h: typeof c.market_cap_change_24h === "number" ? c.market_cap_change_24h : null,
    fetchedAtMs,
  }));
});

interface MarketsResponseRow {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price?: number;
  price_change_percentage_1h_in_currency?: number;
  price_change_percentage_24h_in_currency?: number;
  price_change_percentage_7d_in_currency?: number;
  market_cap?: number;
  fully_diluted_valuation?: number;
  circulating_supply?: number;
  total_supply?: number;
  max_supply?: number;
  total_volume?: number;
}

/** Shared response shape for every /coins/markets call in this file
 * (top-by-market-cap, single-id lookup) — same fields, same nullability
 * rules, just different query params per caller. */
function parseMarketsRow(c: MarketsResponseRow, fetchedAtMs: number): MarketDataRow {
  return {
    fetchedAtMs,
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    imageUrl: c.image ?? null,
    price: typeof c.current_price === "number" ? c.current_price : null,
    change1h: typeof c.price_change_percentage_1h_in_currency === "number" ? c.price_change_percentage_1h_in_currency : null,
    change24h:
      typeof c.price_change_percentage_24h_in_currency === "number" ? c.price_change_percentage_24h_in_currency : null,
    change7d: typeof c.price_change_percentage_7d_in_currency === "number" ? c.price_change_percentage_7d_in_currency : null,
    marketCap: typeof c.market_cap === "number" ? c.market_cap : null,
    fdv: typeof c.fully_diluted_valuation === "number" ? c.fully_diluted_valuation : null,
    circulatingSupply: typeof c.circulating_supply === "number" ? c.circulating_supply : null,
    totalSupply: typeof c.total_supply === "number" ? c.total_supply : null,
    maxSupply: typeof c.max_supply === "number" ? c.max_supply : null,
    volume24h: typeof c.total_volume === "number" ? c.total_volume : null,
  };
}

async function fetchMarketsPage(extraQuery: string, page = 1, perPage = 250): Promise<MarketDataRow[]> {
  const suffix = extraQuery ? `&${extraQuery}` : "";
  const url = `${API_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&price_change_percentage=1h,24h,7d${suffix}`;
  const { value: body, fetchedAtMs } = await cachedMarketsJson<MarketsResponseRow[]>(url, `coins/markets(${extraQuery || "top"})`);
  return body.map((row) => parseMarketsRow(row, fetchedAtMs));
}

/** Every coin in one CoinGecko category, with 1h/24h/7d change and market
 * cap — live, reused only within the 60s price cache (see
 * fetchCategoryStats' own doc comment). Category membership is typically
 * well under 250, so this is one call, not chunked. Revived for Trend
 * Finder v3 — see trendPeers.ts. */
export const fetchCategoryMembers = cache(async (categoryId: string): Promise<MarketDataRow[]> => fetchMarketsPage(`category=${categoryId}`));

/** Every CoinGecko category's id and name — one call. */
export async function fetchCategoryList(): Promise<{ id: string; name: string }[]> {
  const res = await coingeckoFetch(`${API_BASE}/coins/categories/list`, MARKETS_FETCH_OPTS);
  if (!res.ok) throw new Error(`CoinGecko coins/categories/list failed: HTTP ${res.status}`);
  const body: { category_id: string; name: string }[] = await res.json();
  return body.map((c) => ({ id: c.category_id, name: c.name }));
}

/** Every member (id + symbol) of one category, paged — unlike
 * fetchCategoryMembers (one page), for a category that can pass 250 (the
 * generic liquid staking one had 242 on 2026-09-24). Uncached: its only
 * caller (liquidStakingRegistry.ts) stores the result in the DB. */
export async function fetchAllCategoryMembers(categoryId: string): Promise<{ id: string; symbol: string }[]> {
  const out: { id: string; symbol: string }[] = [];
  for (let page = 1; page <= 8; page++) {
    const url = `${API_BASE}/coins/markets?vs_currency=usd&category=${encodeURIComponent(categoryId)}&per_page=250&page=${page}`;
    const res = await coingeckoFetch(url, MARKETS_FETCH_OPTS);
    if (!res.ok) throw new Error(`CoinGecko coins/markets(category=${categoryId}) failed: HTTP ${res.status}`);
    const rows: { id: string; symbol: string }[] = await res.json();
    out.push(...rows.map((r) => ({ id: r.id, symbol: r.symbol })));
    if (rows.length < 250) break;
  }
  return out;
}

/** Live display data for an explicit set of ids, chunked at
 * MARKETS_BATCH_SIZE (CoinGecko's own per-call ids= cap) rather than
 * passed through in one shot — Trend Finder v3's AI-resolved peer list
 * (trendPeers.ts) is always well under 250 so this was previously a no-op
 * distinction, but the screener's universe (screener/snapshot.ts) can
 * realistically exceed it; batching here fixes it for every caller at
 * once instead of adding a second, screener-only wrapper around the same
 * endpoint. Empty input short-circuits without a call. */
export async function fetchMarketsByIds(ids: string[]): Promise<MarketDataRow[]> {
  if (ids.length === 0) return [];
  return fetchMarketsByIdsKey([...new Set(ids)].sort().join(","));
}

// React cache() compares args by identity, so dedupe on a canonical string, not the array.
const fetchMarketsByIdsKey = cache(async (idsCsv: string): Promise<MarketDataRow[]> => {
  const results: MarketDataRow[] = [];
  for (const batch of chunk(idsCsv.split(","), MARKETS_BATCH_SIZE)) {
    results.push(...(await fetchMarketsPage(`ids=${batch.join(",")}`, 1, batch.length)));
  }
  return results;
});

export interface SeedInfo {
  id: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  marketCapRank: number | null;
  price: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  marketCap: number | null;
  /** When CoinGecko actually returned this row (it may come from the 60s price cache). */
  fetchedAtMs: number;
}

/** A Trend Finder seed's own display info (name/symbol/image/rank) plus its
 * live price/1h/24h/7d change and market cap — one call, reused only
 * within the 60s price cache (see PRICE_TTL_MS; `fetchedAtMs` drives the
 * page's "priced X ago" caption).
 * Deliberately a small overlap with parseMarketsRow's own mapping rather
 * than sharing a helper for it — this is the only caller that also needs
 * name/marketCapRank, not worth threading an extra flag through the shared
 * path for. Null when CoinGecko has no market row for this id (a real
 * possibility for a very illiquid coin picked via /search). */
export async function fetchSeedInfo(coingeckoId: string): Promise<SeedInfo | null> {
  return (await fetchSeedInfos([coingeckoId])).get(coingeckoId) ?? null;
}

/** Several seeds in ONE /coins/markets call (Compare's two tokens). Keyed by
 * the requested id; an id CoinGecko has no market row for is simply absent. */
export async function fetchSeedInfos(coingeckoIds: string[]): Promise<Map<string, SeedInfo>> {
  if (coingeckoIds.length === 0) return new Map();
  return fetchSeedInfosKey([...new Set(coingeckoIds)].sort().join(","));
}

const fetchSeedInfosKey = cache(async (idsCsv: string): Promise<Map<string, SeedInfo>> => {
  const url = `${API_BASE}/coins/markets?vs_currency=usd&ids=${idsCsv}&price_change_percentage=1h,24h,7d`;
  const { value: body, fetchedAtMs } = await cachedMarketsJson<
    {
      id: string;
      symbol: string;
      name: string;
      image?: string;
      market_cap_rank?: number | null;
      current_price?: number;
      price_change_percentage_1h_in_currency?: number;
      price_change_percentage_24h_in_currency?: number;
      price_change_percentage_7d_in_currency?: number;
      market_cap?: number;
    }[]
  >(url, `coins/markets(ids=${idsCsv})`);
  return new Map(
    body.map((c) => [
      c.id,
      {
        id: c.id,
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        imageUrl: c.image ?? null,
        marketCapRank: typeof c.market_cap_rank === "number" ? c.market_cap_rank : null,
        price: typeof c.current_price === "number" ? c.current_price : null,
        change1h: typeof c.price_change_percentage_1h_in_currency === "number" ? c.price_change_percentage_1h_in_currency : null,
        change24h:
          typeof c.price_change_percentage_24h_in_currency === "number" ? c.price_change_percentage_24h_in_currency : null,
        change7d: typeof c.price_change_percentage_7d_in_currency === "number" ? c.price_change_percentage_7d_in_currency : null,
        marketCap: typeof c.market_cap === "number" ? c.market_cap : null,
        fetchedAtMs,
      },
    ]),
  );
});

/** A coin's raw CoinGecko category names (function, chain ecosystems,
 * investor portfolios, indexes — all mixed; see categoryFilter.ts for which
 * ones Trend Finder actually uses). /coins/{id} is the most rate-limited
 * call Trend Finder makes (429s at ~3s spacing, per coin_categories' own
 * schema comment), so callers go through trendPeers.ts's cached
 * getCoinCategories, never this directly per page load. Null when
 * CoinGecko has no such coin. */
export async function fetchCoinCategories(coingeckoId: string): Promise<string[] | null> {
  const url = `${API_BASE}/coins/${encodeURIComponent(coingeckoId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`;
  const res = await coingeckoFetch(url, MARKETS_FETCH_OPTS);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CoinGecko coins/${coingeckoId} failed: HTTP ${res.status}`);
  const body: { categories?: (string | null)[] } = await res.json();
  return (body.categories ?? []).filter((c): c is string => typeof c === "string" && c.length > 0);
}

export async function fetchNativePrice(coingeckoId: string): Promise<number | null> {
  const url = `${API_BASE}/simple/price?ids=${coingeckoId}&vs_currencies=usd`;
  const res = await coingeckoFetch(url, MARKETS_FETCH_OPTS); // same reason as fetchTokenPrices
  if (!res.ok) throw new Error(`CoinGecko simple/price(${coingeckoId}) failed: HTTP ${res.status}`);
  const body: Record<string, { usd?: number }> = await res.json();
  return body[coingeckoId]?.usd ?? null;
}

export interface CoinSearchResult {
  id: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  marketCapRank: number | null;
}

/**
 * Live-verified (2026-09): free, keyless, same API_BASE this file already
 * uses elsewhere. Exists specifically to disambiguate a bare ticker symbol
 * — CoinGecko returns every coin sharing that symbol (e.g. 20+ distinct
 * coins for "PEPE"), ordered by relevance/market-cap rank, which is exactly
 * what the Watchlist's add flow needs to let a user pick the real coin
 * instead of guessing. Nothing else in this file resolves a bare symbol —
 * every other lookup here needs a contract+chain or a known native-chain
 * symbol (see priceKey.ts's resolveCoingeckoKey, which deliberately never
 * guesses either).
 *
 * Reused for 60s across requests (same TTL cache as prices; identical
 * in-flight searches share one call; failures aren't cached) and deduped per
 * request: a Trend view re-resolves the same AI-named peers ("PUMP", "UNI")
 * on every render, and a search result doesn't change within a minute. No
 * prices in it, so no age caption is needed.
 */
export const searchCoins = cache(async (query: string): Promise<CoinSearchResult[]> => {
  const url = `${API_BASE}/search?query=${encodeURIComponent(query)}`;
  const { value: body } = await searchCache.get(url, async () => {
    const res = await coingeckoFetch(url);
    if (!res.ok) throw new Error(`CoinGecko search failed: HTTP ${res.status}`);
    return (await res.json()) as {
      coins?: { id: string; symbol: string; name: string; thumb?: string; market_cap_rank?: number | null }[];
    };
  });
  return (body.coins ?? []).map((c) => ({
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    imageUrl: c.thumb || null,
    marketCapRank: typeof c.market_cap_rank === "number" ? c.market_cap_rank : null,
  }));
});

export interface DailyPricePoint {
  /** UTC calendar date, YYYY-MM-DD — matches portfolio_snapshots' and
   * wallet_snapshots' own snapshot_date semantics. */
  date: string;
  usd: number;
}

/** A priceKey.ts key is either a bare coin id ("bitcoin") or
 * "<platform>:<contract>" ("ethereum:0xc02aaa...") — this picks the
 * matching free market_chart endpoint. */
function marketChartUrl(key: string, days: number): string {
  const sep = key.indexOf(":");
  if (sep === -1) return `${API_BASE}/coins/${key}/market_chart?vs_currency=usd&days=${days}`;
  const platform = key.slice(0, sep);
  const contract = key.slice(sep + 1);
  return `${API_BASE}/coins/${platform}/contract/${contract}/market_chart?vs_currency=usd&days=${days}`;
}

/** Shared fetch+bucket core for both fetchDailyHistory and
 * fetchHourlyHistory — same URL builder, same retry/404 handling, same
 * "collapse to the latest price observed in each bucket" rule; the two
 * callers differ only in how coarse a bucket is (10-char ISO prefix = UTC
 * calendar day, 13-char = UTC hour). A 404 means CoinGecko doesn't have
 * this asset at all — not a fetch failure, just zero coverage for it (see
 * priceHistory.ts's caller). */
async function fetchBucketedHistory(key: string, days: number, isoPrefixLen: number): Promise<[string, number][]> {
  const url = marketChartUrl(key, days);
  const res = await coingeckoFetch(url);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`CoinGecko market_chart(${key}) failed: HTTP ${res.status}`);
  }
  const body: { prices?: [number, number][] } = await res.json();

  const byBucket = new Map<string, number>();
  for (const [timestampMs, usd] of body.prices ?? []) {
    byBucket.set(new Date(timestampMs).toISOString().slice(0, isoPrefixLen), usd);
  }
  return [...byBucket.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Daily USD close for the last `days` days, for one priceKey.ts key — both
 * the coin-id endpoint (native tokens) and the contract-address endpoint
 * (everything with a `contract`); see marketChartUrl above for which key
 * shape routes to which, and priceKey.ts for how a holding produces a key.
 * `prices` arrives sorted ascending by timestamp, so this lines up with the
 * once-a-day snapshot tables' shape.
 */
export async function fetchDailyHistory(key: string, days: number): Promise<DailyPricePoint[]> {
  const buckets = await fetchBucketedHistory(key, days, 10);
  return buckets.map(([date, usd]) => ({ date, usd }));
}

export interface HourlyPricePoint {
  /** UTC hour, "YYYY-MM-DDTHH" — one point per hour, the latest price
   * CoinGecko reported within that hour. */
  hour: string;
  usd: number;
}

/**
 * Hourly USD close for the last `days` days (CoinGecko only returns
 * hourly-or-finer granularity for days<=90 — beyond that it silently drops
 * to daily, so callers needing hourly resolution must stay under that
 * ceiling). Built for correlation.ts: daily-bucketed 90d returns give only
 * ~90 return observations (a 95% CI of ±0.21 on a Pearson estimate — too
 * noisy to separate a real peer from noise, live-verified this session),
 * while hourly gives ~2160 (±0.04) — the difference between a usable and
 * an unusable signal, not a cosmetic one.
 */
export async function fetchHourlyHistory(key: string, days: number): Promise<HourlyPricePoint[]> {
  const buckets = await fetchBucketedHistory(key, days, 13);
  return buckets.map(([hour, usd]) => ({ hour, usd }));
}

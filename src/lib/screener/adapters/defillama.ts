import "server-only";
import { fetchWithRetry } from "@/lib/adapters/http";

const BASE = "https://api.llama.fi";

export interface DefiLlamaProtocol {
  slug: string;
  geckoId: string | null;
  name: string;
  symbol: string;
  category: string | null;
  tvl: number | null;
  /** DefiLlama's own market cap figure — kept separate from CoinGecko's for
   * the conflict-detection check (see snapshot.ts), never itself the value
   * written to screener_asset_snapshots.market_cap_usd (CoinGecko is the
   * primary source there; this is only the comparison point). */
  mcap: number | null;
  /** e.g. "parent#uniswap" — live-verified 2026-09-22 this is a real,
   * common pattern, not an edge case: DefiLlama splits major protocols
   * into versioned/product-line children (Uniswap V1/V2/V3/V4, GMX V1/V2
   * Perps/AMM, Hyperliquid Bridge/Spot/HLP/Perps) and NONE of them carry
   * their own gecko_id — it lives only on the parent aggregate (see
   * fetchParentProtocols). Uniswap, Hyperliquid, and GMX (three of the
   * highest-revenue protocols that exist) were silently entirely absent
   * from the universe before this was accounted for — not a rare gap. */
  parentProtocol: string | null;
}

/** Every DefiLlama-tracked protocol in one call — live-verified 2026-09-22:
 * 8,325 rows, 8.9MB, no auth, no documented rate limit. Never called per-
 * protocol; the whole point of this endpoint is that it isn't. */
export async function fetchProtocols(): Promise<DefiLlamaProtocol[]> {
  const res = await fetchWithRetry(`${BASE}/protocols`);
  if (!res.ok) throw new Error(`DefiLlama /protocols failed: HTTP ${res.status}`);
  const body: {
    slug: string;
    gecko_id?: string | null;
    name: string;
    symbol?: string;
    category?: string | null;
    tvl?: number | null;
    mcap?: number | null;
    parentProtocol?: string | null;
  }[] = await res.json();
  return body.map((p) => ({
    slug: p.slug,
    geckoId: p.gecko_id ?? null,
    name: p.name,
    symbol: p.symbol ?? "",
    category: p.category ?? null,
    tvl: typeof p.tvl === "number" ? p.tvl : null,
    mcap: typeof p.mcap === "number" ? p.mcap : null,
    parentProtocol: p.parentProtocol ?? null,
  }));
}

export interface DefiLlamaParentProtocol {
  id: string; // "parent#uniswap"
  geckoId: string | null;
  name: string;
  mcap: number | null;
}

/**
 * The aggregate-level entries child protocols roll up to via their own
 * `parentProtocol` field — live-verified 2026-09-22 via
 * /lite/protocols2's `parentProtocols` array (845 entries; `/protocols`
 * itself contains no parent-level rows at all, confirmed by checking
 * directly — this really is a separate resource, not a different key on
 * the same one). Note the field name is `gecko_id` here too (snake_case),
 * unlike this same payload's own `protocols` array, which uses `geckoId`
 * (camelCase) — a real, live-verified inconsistency in DefiLlama's own
 * response shape, not a typo in this adapter.
 */
export async function fetchParentProtocols(): Promise<Map<string, DefiLlamaParentProtocol>> {
  const res = await fetchWithRetry(`${BASE}/lite/protocols2`);
  if (!res.ok) throw new Error(`DefiLlama /lite/protocols2 failed: HTTP ${res.status}`);
  const body: { parentProtocols: { id: string; gecko_id?: string | null; name: string; mcap?: number | null }[] } =
    await res.json();
  const map = new Map<string, DefiLlamaParentProtocol>();
  for (const p of body.parentProtocols) {
    map.set(p.id, { id: p.id, geckoId: p.gecko_id ?? null, name: p.name, mcap: typeof p.mcap === "number" ? p.mcap : null });
  }
  return map;
}

export type FeesDataType = "dailyFees" | "dailyRevenue" | "dailyHoldersRevenue";

export interface ProtocolFeeTotals {
  slug: string;
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  total1y: number | null;
}

/**
 * Every protocol's totals for one metric, in one call — live-verified
 * 2026-09-22: ~2,736 protocols, one response, keyed by `slug`. `dataType`
 * changes what the totals MEAN, not just a label: live-verified on Aave,
 * same endpoint shape, only this param changed — dailyFees $1,347,376/24h,
 * dailyRevenue $172,934/24h, dailyHoldersRevenue $0/24h. Fetch each of the
 * 3 dataTypes as its own call (3 calls total for the whole universe, not
 * 3×N) — this is what makes the daily snapshot job cheap regardless of how
 * many assets are in the universe.
 *
 * NOTE on the dailyHoldersRevenue "$0" ambiguity (see DATA_SOURCES.md /
 * PHASE_0.md §9): a literal 0 here does not distinguish "confirmed zero
 * capture" from "DefiLlama doesn't track this for this protocol." This
 * function returns the raw number either way — callers computing
 * `capture`/`buyback_yield` (Phase 2) are responsible for treating it as
 * null unless the protocol is in `KNOWN_HOLDER_VALUE_MECHANISMS`, not this
 * fetcher's job to decide.
 */
export async function fetchFeesOverview(dataType: FeesDataType): Promise<Map<string, ProtocolFeeTotals>> {
  const res = await fetchWithRetry(`${BASE}/overview/fees?dataType=${dataType}`);
  if (!res.ok) throw new Error(`DefiLlama /overview/fees(${dataType}) failed: HTTP ${res.status}`);
  const body: {
    protocols: {
      slug: string;
      total24h?: number | null;
      total7d?: number | null;
      total30d?: number | null;
      total1y?: number | null;
    }[];
  } = await res.json();
  const map = new Map<string, ProtocolFeeTotals>();
  for (const p of body.protocols) {
    map.set(p.slug, {
      slug: p.slug,
      total24h: typeof p.total24h === "number" ? p.total24h : null,
      total7d: typeof p.total7d === "number" ? p.total7d : null,
      total30d: typeof p.total30d === "number" ? p.total30d : null,
      total1y: typeof p.total1y === "number" ? p.total1y : null,
    });
  }
  return map;
}

export interface ProtocolFeeHistoryPoint {
  /** UTC calendar date, YYYY-MM-DD — converted from the endpoint's raw
   * Unix-seconds epoch (live-verified: 1607040000 -> 2020-12-04, seconds
   * not milliseconds). */
  date: string;
  value: number;
}

/** Per-protocol daily history — backfill only (§ PHASE_1.md). The current-
 * snapshot path (runScreenerSnapshot) never calls this; fetchFeesOverview
 * covers every protocol in one call each. Live-verified depth for Aave:
 * 2,119 daily rows back to 2020-12-04.
 *
 * 404 AND 400 both mean "no coverage," not a fetch failure — live-
 * verified during backfill testing: DefiLlama returns 400 with the body
 * `"Fees for {slug} not found, please visit /overview/fees to see
 * available protocols"` for a (protocol, dataType) pair it simply doesn't
 * track (e.g. Chainlink/Bitcoin have no `dailyHoldersRevenue` category at
 * all) — semantically identical to 404's "no data," just a different
 * status code for it. Both return an empty array, never throw; this
 * matters beyond just that one protocol's one metric — the caller
 * (backfill.ts) fetches all 4 series per asset via Promise.all, so
 * treating this as a real error would have silently killed the OTHER 3
 * series (price, fees, revenue) that did succeed for the same asset. */
export async function fetchProtocolFeeHistory(slug: string, dataType: FeesDataType): Promise<ProtocolFeeHistoryPoint[]> {
  const res = await fetchWithRetry(`${BASE}/summary/fees/${encodeURIComponent(slug)}?dataType=${dataType}`);
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) return [];
    throw new Error(`DefiLlama /summary/fees/${slug}(${dataType}) failed: HTTP ${res.status}`);
  }
  const body: { totalDataChart?: [number, number][] } = await res.json();
  return (body.totalDataChart ?? []).map(([epochSeconds, value]) => ({
    date: new Date(epochSeconds * 1000).toISOString().slice(0, 10),
    value,
  }));
}

export interface StablecoinSupply {
  totalUsd: number;
  prevMonthUsd: number;
  /** USD-pegged assets counted — ones missing either figure are left out of
   * BOTH sums, so the 30d change compares like with like. */
  assetsCounted: number;
}

/** Total USD-pegged stablecoin supply now and ~30 days ago, from DefiLlama's
 * stablecoins snapshot (live-verified 2026-09-22: 339 peggedUSD assets, each
 * with circulating.peggedUSD and circulatingPrevMonth.peggedUSD). One call —
 * no per-stablecoin history needed for a 30-day change. */
export async function fetchStablecoinSupply(): Promise<StablecoinSupply> {
  const res = await fetchWithRetry("https://stablecoins.llama.fi/stablecoins?includePrices=false");
  if (!res.ok) throw new Error(`DefiLlama /stablecoins failed: HTTP ${res.status}`);
  const body: {
    peggedAssets: { pegType?: string; circulating?: { peggedUSD?: number }; circulatingPrevMonth?: { peggedUSD?: number } }[];
  } = await res.json();
  let totalUsd = 0;
  let prevMonthUsd = 0;
  let assetsCounted = 0;
  for (const a of body.peggedAssets) {
    const now = a.circulating?.peggedUSD;
    const prev = a.circulatingPrevMonth?.peggedUSD;
    if (a.pegType !== "peggedUSD" || typeof now !== "number" || typeof prev !== "number") continue;
    totalUsd += now;
    prevMonthUsd += prev;
    assetsCounted++;
  }
  return { totalUsd, prevMonthUsd, assetsCounted };
}

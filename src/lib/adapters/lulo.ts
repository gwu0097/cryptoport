import "server-only";
import { fetchWithRetry } from "./http";
import { fetchTokenInfo } from "./jupiter";
import type { AdapterHolding } from "./types";

const API_BASE = "https://api.lulo.fi";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

// Display names for the underlying protocols Lulo's aggregator (see
// fetchLuloPositions' own doc comment) routes deposits into — from its own
// pools.getPoolMeta rate feed. Falls back to a title-cased version of the
// raw key for anything not listed here, rather than hiding or mislabeling
// a protocol this app doesn't specifically recognize yet.
const PROTOCOL_NAMES: Record<string, string> = {
  kamino: "Kamino",
  kamino_jlp: "Kamino JLP",
  kamino_p: "Kamino P",
  jupiter: "Jupiter",
  drift: "Drift",
  marginfi: "MarginFi",
  maple: "Maple",
  morpho: "Morpho",
  pendle: "Pendle",
  gami_cap: "Gami Cap",
  loop_onr: "Loop",
};

function protocolDisplayName(key: string): string {
  return (
    PROTOCOL_NAMES[key] ??
    key
      .split("_")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

interface FlagshipAccountResponse {
  lusdUsdBalance: number;
  pusdUsdBalance: number;
  maxWithdrawable?: {
    protected?: Record<string, number>;
    regular?: Record<string, number>;
  };
}

interface AggregatorAccountResponse {
  accountExists: boolean;
  protocolDistributionsV2?: Record<string, Record<string, { usdValue: number; balance: number }>>;
}

interface RawEntry {
  mint: string;
  protocol: string;
  qty: number;
}

/**
 * Lulo (lulo.fi) has two genuinely separate products, confirmed via its own
 * OpenAPI spec (api.lulo.fi/openapi.json) and live-tested against a real
 * wallet with positions in both:
 * - v1/account.getAccount — the flagship USDC-only "Protected"/"Regular"
 *   pools (fixed yield tiers). This is all the original version of this
 *   adapter covered.
 * - v0/account.getAccount — a broader multi-asset "aggregator" that routes
 *   deposits into whichever underlying money market (Kamino, Jupiter,
 *   Drift, MarginFi, ...) offers the best rate for a given asset. jup.ag's
 *   own "Lulo" card shows this as "Lending — <protocol>" — reported
 *   directly that this app was missing it entirely: for the same test
 *   wallet, this was $3,194.88 of wSOL via Kamino against $7.88 in the
 *   flagship pool, i.e. the overwhelming majority of this wallet's real
 *   Lulo exposure.
 * Both are free and keyless.
 *
 * Neither response's own USD-value fields are used for valuation — the
 * same real wallet's v0 response reported its wSOL position at an implied
 * price of ~$96/SOL while this app's own live SOL price was ~$112 at the
 * exact same moment (Lulo's internal price feed was simply stale, not a
 * parsing bug). Every holding here is recorded as ticker + qty (+ contract
 * for anything that isn't SOL itself, to avoid a ticker-collision
 * mispricing — the same fix-class as this session's DOG bug) and priced
 * through this app's own existing, fresh pipeline instead.
 */
export async function fetchLuloPositions(address: string): Promise<AdapterHolding[]> {
  const [flagship, aggregator] = await Promise.all([
    fetchWithRetry(`${API_BASE}/v1/account.getAccount?owner=${address}`).then((r) => {
      if (!r.ok) throw new Error(`Lulo flagship account lookup failed: HTTP ${r.status}`);
      return r.json() as Promise<FlagshipAccountResponse>;
    }),
    fetchWithRetry(`${API_BASE}/v0/account.getAccount?owner=${address}`).then((r) => {
      if (!r.ok) throw new Error(`Lulo aggregator account lookup failed: HTTP ${r.status}`);
      return r.json() as Promise<AggregatorAccountResponse>;
    }),
  ]);

  const entries: RawEntry[] = [];

  const protectedQty = flagship.maxWithdrawable?.protected?.[USDC_MINT] ?? 0;
  if (flagship.pusdUsdBalance > 0 && protectedQty > 0) {
    entries.push({ mint: USDC_MINT, protocol: "Lulo: Protected", qty: protectedQty });
  }
  const regularQty = flagship.maxWithdrawable?.regular?.[USDC_MINT] ?? 0;
  if (flagship.lusdUsdBalance > 0 && regularQty > 0) {
    entries.push({ mint: USDC_MINT, protocol: "Lulo: Regular", qty: regularQty });
  }

  if (aggregator.accountExists && aggregator.protocolDistributionsV2) {
    for (const [mint, byProtocol] of Object.entries(aggregator.protocolDistributionsV2)) {
      for (const [protocolKey, position] of Object.entries(byProtocol)) {
        if (position.balance > 0) {
          entries.push({ mint, protocol: `Lulo: ${protocolDisplayName(protocolKey)}`, qty: position.balance });
        }
      }
    }
  }

  if (entries.length === 0) return []; // no Lulo position at all — a real $0, not an error

  const distinctMints = [...new Set(entries.map((e) => e.mint))];
  const tokenInfo = await fetchTokenInfo(distinctMints).catch(() => new Map()); // icons/tickers are cosmetic — never fail over it

  return entries.map(({ mint, protocol, qty }) => {
    const info = tokenInfo.get(mint);
    const ticker = info?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    return {
      ticker,
      qty,
      usd_override: null,
      // Wrapped SOL prices safely via the native-symbol match
      // (resolveCoingeckoKey) without needing a contract; every other
      // mint needs its own contract to avoid a ticker-collision
      // mispricing.
      contract: mint === WRAPPED_SOL_MINT ? null : mint,
      category: "defi",
      chain: "solana-defi",
      icon_url: info?.icon ?? null,
      protocol,
      protocol_url: "https://app.lulo.fi/",
    };
  });
}

import "server-only";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import { fetchTokenImages, fetchTokenPrices } from "./coingecko";
import type { AdapterHolding } from "./types";

// PublicNode's Sui endpoint — verified live (sui-rpc.publicnode.com, not
// the mainnet full-node domain: that host's TLS handshake didn't complete
// from this app's network path, PublicNode's does).
const RPC = "https://sui-rpc.publicnode.com";
const NATIVE_COIN_TYPE = "0x2::sui::SUI";
// CoinGecko's asset_platforms id for Sui — live-verified via
// GET /asset_platforms (id: "sui", native_coin_id: "sui"), same convention
// as chains.ts's coingeckoPlatform used for EVM contract pricing below.
const COINGECKO_PLATFORM = "sui";

const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

export function isSuiAddress(value: string): boolean {
  return SUI_ADDRESS_RE.test(value);
}

interface CoinBalance {
  coinType: string;
  totalBalance: string; // base units, decimal string
}

interface CoinMetadata {
  decimals: number;
  name: string;
  symbol: string;
  iconUrl: string | null;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetchWithRetry(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cryptoport", method, params }),
  });
  if (!res.ok) throw new Error(`Sui RPC (${method}) failed: HTTP ${res.status}`);
  const body: { result?: T; error?: { message: string } } = await res.json();
  if (body.error) throw new Error(`Sui RPC (${method}) error: ${body.error.message}`);
  return body.result as T;
}

/** A real HTTPS URL, or null — suix_getCoinMetadata can return a
 * `data:image/...;base64,...` icon inline (seen live: one coin's metadata
 * carried a >100KB embedded JPEG this way) instead of a hosted URL. Storing
 * that verbatim would bloat this holding's row and every page that renders
 * it for no benefit over the existing letter-avatar fallback, so only a
 * genuine link is kept. */
function realIconUrl(iconUrl: string | null): string | null {
  return iconUrl && iconUrl.startsWith("http") ? iconUrl : null;
}

/**
 * Every coin type the address holds a nonzero balance of — not just native
 * SUI. Reported directly, with real data: a wallet holding SUI, USDC, and a
 * meme token only showed SUI, because the original version of this adapter
 * only ever called suix_getBalance (a single, native-only balance check).
 * suix_getAllBalances enumerates every coin type Sui itself tracks for an
 * address; suix_getCoinMetadata resolves each type's symbol/decimals/icon
 * (live-verified: both endpoints work against the same PublicNode RPC
 * already in use, no new provider needed).
 *
 * Non-native coins are priced the same way multicallEvm.ts prices EVM
 * tokens: a real per-*contract* CoinGecko lookup (fetchTokenPrices against
 * the "sui" asset platform, live-verified against this wallet's real coin
 * types — resolved USDC/AUSD/S/BLUE/SCB/TARDI correctly, including "S",
 * which is priced at its own ~$0.0001 rather than colliding with an
 * unrelated asset that happens to share that short ticker). This is
 * deliberately NOT a self-reported-symbol stablecoin pin (the earlier draft
 * of this fix trusted `meta.symbol === "USDC"`, which is exactly the
 * spoofed-token shape CLAUDE.md's Data Correctness rule warns about — a
 * coin's publisher controls its own symbol string, not CoinGecko).
 *
 * KNOWN GAP, same one valuation.ts already documents for Solana SPL
 * balances: a coin type CoinGecko can't price by contract (seen live: a
 * few genuinely obscure ones — SuiReward, GMB, a coin literally named
 * "TOKEN") falls through to the shared ticker-keyed `prices` table, same
 * collision risk as any other unpriced-by-contract token. Not closed here
 * for the same reason it isn't closed for Solana: excluding a holding from
 * that fallback entirely is a valuation.ts design change, not a one-line
 * patch. In practice this only affects long-tail/illiquid coins with no
 * CoinGecko contract listing at all.
 *
 * Native SUI itself is unchanged — still priced via the existing
 * ticker-keyed `prices` table (SUI is CoinGecko's platform's own native
 * asset, not a candidate for a ticker collision the way an arbitrary
 * third-party coin type is).
 */
export async function fetchSuiHoldings(address: string): Promise<AdapterHolding[]> {
  const balances = await rpc<CoinBalance[]>("suix_getAllBalances", [address]);
  const held = balances.filter((b) => BigInt(b.totalBalance) > BigInt(0));
  if (held.length === 0) return [];

  const metadataByType = new Map<string, CoinMetadata | null>();
  await mapWithConcurrency(held, 5, async (b) => {
    try {
      const meta = await rpc<CoinMetadata | null>("suix_getCoinMetadata", [b.coinType]);
      metadataByType.set(b.coinType, meta);
    } catch {
      // One coin type's metadata failing to resolve (a malformed/rug'd
      // token, a transient RPC hiccup) never drops the rest of the
      // wallet's real, verified balances — same "one source's failure
      // never discards another's correctly-fetched data" rule this app
      // applies everywhere else.
      metadataByType.set(b.coinType, null);
    }
  });

  const nonNativeTypes = held.filter((b) => b.coinType !== NATIVE_COIN_TYPE).map((b) => b.coinType);
  const contractPrices = await fetchTokenPrices(COINGECKO_PLATFORM, nonNativeTypes).catch(() => new Map());

  const holdings: AdapterHolding[] = [];
  for (const b of held) {
    const meta = metadataByType.get(b.coinType);
    // No metadata resolved at all means no decimals to scale the raw base-
    // unit balance by — showing a real quantity with a made-up decimal
    // count would be a wrong number, not a missing one, so this coin type
    // is skipped rather than guessed. Rare in practice (only seen for a
    // genuinely broken/unregistered coin type).
    if (!meta) continue;

    const qty = Number(b.totalBalance) / 10 ** meta.decimals;
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const isNative = b.coinType === NATIVE_COIN_TYPE;
    const priceEntry = isNative ? undefined : contractPrices.get(b.coinType.toLowerCase());
    holdings.push({
      ticker: meta.symbol.toUpperCase(),
      qty,
      usd_override: priceEntry ? qty * priceEntry.usd : null,
      contract: isNative ? null : b.coinType,
      category: "token",
      chain: "sui",
      icon_url: realIconUrl(meta.iconUrl),
    });
  }

  // SUI's own icon still comes from CoinGecko (matching the pre-existing
  // behavior) rather than Sui's own metadata endpoint, which returned an
  // empty iconUrl for the native coin in live testing.
  const suiHolding = holdings.find((h) => h.contract === null);
  if (suiHolding && !suiHolding.icon_url) {
    const images = await fetchTokenImages(["sui"]).catch(() => new Map<string, string>());
    suiHolding.icon_url = images.get("sui") ?? null;
  }

  return holdings;
}

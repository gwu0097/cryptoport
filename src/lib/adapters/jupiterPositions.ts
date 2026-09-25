import "server-only";
import { jupiterFetch } from "./jupiterFetch";
import type { AdapterHolding } from "./types";

const API_BASE = "https://api.jup.ag/portfolio/v1";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
// Optional — works keyless too, same as jupiter.ts's own api.jup.ag calls;
// JUPITER_API_KEY just unlocks a higher rate limit when set.
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const HEADERS: Record<string, string> = JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};

interface PositionAssetData {
  address?: string;
  amount?: number;
  price?: number;
}

interface PositionAsset {
  type: string;
  data?: PositionAssetData;
}

interface Liquidity {
  assets: PositionAsset[];
  assetsValue: number;
  value: number;
  /** Deep link to this specific position on jup.ag, e.g.
   * "https://jup.ag/lend/earn?symbol=SOL&action=deposit". */
  link?: string;
}

interface PositionElement {
  type: string;
  label?: string;
  name?: string;
  platformId?: string;
  value: number | null;
  fetcherId?: string;
  data?: {
    liquidities?: Liquidity[];
    assets?: { input?: PositionAsset | null; output?: PositionAsset | null };
    /** Deep link to this position — present on "trade" (limit order)
     * elements, alongside input/output above. */
    link?: string;
  };
}

interface FetcherReport {
  id: string;
  status: "success" | "failed";
  error?: string;
}

interface TokenInfoEntry {
  symbol?: string;
  logoURI?: string;
}

interface PositionsResponse {
  elements: PositionElement[];
  fetcherReports: FetcherReport[];
  tokenInfo?: { solana?: Record<string, TokenInfoEntry> };
}

export interface JupiterPositionsResult {
  holdings: AdapterHolding[];
  warnings: string[];
}

function resolveAsset(
  mint: string | undefined,
  tokenInfo: Record<string, TokenInfoEntry> | undefined,
): { ticker: string; icon: string | null } {
  if (!mint) return { ticker: "UNKNOWN", icon: null };
  if (mint === WRAPPED_SOL_MINT) return { ticker: "SOL", icon: tokenInfo?.[mint]?.logoURI ?? null };
  const info = tokenInfo?.[mint];
  return { ticker: info?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`, icon: info?.logoURI ?? null };
}

// "LimitOrder" -> "Limit Order" — every label observed so far is a bare
// PascalCase word/phrase (Vault, LimitOrder, ...), not free text, so this
// simple split is enough without a hand-maintained per-type display name.
function humanize(label: string): string {
  return label.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * Jupiter's hosted positions API — the maintained successor to the
 * SonarWatch portfolio engine after Jupiter acquired it (see commit
 * message for why the `@sonarwatch/portfolio-*` npm packages themselves
 * were rejected: deprecated on npm, last protocol update mid-2025, 5
 * critical/44 high `npm audit` vulnerabilities). Verified against
 * api.jup.ag/portfolio/v1/platforms and empirically against 9 real
 * wallets: this only covers Jupiter's own product suite (Earn, Limit
 * Order, Perps, DCA, ...), NOT third-party protocols like
 * Marinade/Kamino/Raydium/Drift — those still show up nowhere in this app
 * until a wallet-specific list of protocols to hand-build is provided.
 *
 * Every returned holding is tagged with `protocol` (e.g. "Jupiter Earn")
 * and `protocol_url` (a deep link to the position on jup.ag) when Jupiter's
 * response has them, so the UI can show which product a DeFi position
 * lives in and link straight to it — the same breakdown DeBank/Rabby show
 * for EVM DeFi, just sourced from Jupiter instead of a paid aggregator.
 *
 * Kept as its own adapter (not folded into jupiter.ts's plain SPL-balance
 * fetch) since a failure here must never discard the wallet's regular
 * token holdings — same hard-failure-must-be-independent-per-source rule
 * as evm.ts's chains vs. Hyperliquid split.
 */
// Products read from Jupiter's dedicated APIs instead, because this API's
// fetcher for them failed (2026-09-25): Perps (jupiterPerps.ts — "Discriminant
// 225 out of range" for every wallet with a perps account, since 2026-09-10)
// and Prediction (jupiterPrediction.ts — Jupiter's own backend rate limit on
// most wallets). Their reports and any elements they return are skipped, so a
// position is never counted twice if a fetcher starts working again.
const SKIPPED_FETCHERS = new Set(["jupiter-exchange-perpetual", "jupiter-pm-positions"]);

const RATE_LIMIT_RETRY_MS = 3_000;

const failedFetchers = (body: PositionsResponse) =>
  (body.fetcherReports ?? []).filter((r) => r.status === "failed" && !SKIPPED_FETCHERS.has(r.id));

async function getPositions(address: string): Promise<PositionsResponse> {
  const res = await jupiterFetch(`${API_BASE}/positions/${address}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Jupiter positions failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchJupiterPositions(address: string): Promise<JupiterPositionsResult> {
  let body = await getPositions(address);
  // A product fetcher inside Jupiter's service can hit Jupiter's own backend
  // rate limit ("rate limit exceeded" on jupiter-pm-positions) even when our
  // call succeeded — it's their limit, not ours. Asked once more after a
  // pause, and the second answer is used either way.
  if (failedFetchers(body).some((r) => /rate limit/i.test(r.error ?? ""))) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
    body = await getPositions(address);
  }
  const tokenInfo = body.tokenInfo?.solana;

  // A fetcher failing means that one position type is unknown, not that
  // it's zero — surfaced as a warning rather than silently treated as
  // "nothing there".
  const warnings = failedFetchers(body).map((r) => `jupiter positions(${r.id}): ${r.error ?? "unknown error"}`);

  const holdings: AdapterHolding[] = [];

  for (const el of body.elements ?? []) {
    if (el.fetcherId && SKIPPED_FETCHERS.has(el.fetcherId)) continue;
    const label = el.name ?? el.label ?? el.fetcherId ?? el.type;
    const protocol = `Jupiter ${humanize(label)}`;

    if (el.type === "liquidity" && el.data?.liquidities) {
      for (const liq of el.data.liquidities) {
        // A single-asset vault (e.g. Jupiter Earn) is really just the
        // underlying token held elsewhere — record it as that real token
        // (priced normally through this app's own price table) rather than
        // a synthetic USD blob, same as every other holding.
        if (liq.assets.length === 1 && liq.assets[0].data?.amount != null) {
          const asset = resolveAsset(liq.assets[0].data.address, tokenInfo);
          holdings.push({
            ticker: asset.ticker,
            qty: liq.assets[0].data.amount,
            usd_override: null,
            contract: liq.assets[0].data.address ?? null,
            category: "defi",
            chain: "solana-defi",
            icon_url: asset.icon,
            protocol,
            protocol_url: liq.link ?? null,
          });
        } else if (liq.value != null && liq.value !== 0) {
          holdings.push({
            ticker: `JUP-${label.toUpperCase()}`,
            qty: null,
            usd_override: liq.value,
            contract: null,
            category: "defi",
            chain: "solana-defi",
            icon_url: null,
            protocol,
            protocol_url: liq.link ?? null,
          });
        }
      }
      continue;
    }

    if (el.type === "trade" && el.data?.assets?.input) {
      const input = el.data.assets.input;
      const asset = resolveAsset(input.data?.address, tokenInfo);
      // The escrowed token is often a thinly-traded/spam mint this app's own
      // CoinGecko-backed pricing has no reliable price for — Jupiter's own
      // `value` (its live quote at order-placement/check time) is pinned
      // via usd_override instead of trusting the ticker-price pipeline.
      holdings.push({
        ticker: asset.ticker,
        qty: input.data?.amount ?? null,
        usd_override: el.value,
        contract: input.data?.address ?? null,
        category: "defi",
        chain: "solana-defi",
        icon_url: asset.icon,
        protocol,
        protocol_url: el.data.link ?? null,
      });
      continue;
    }

    // Any other Jupiter product (DCA, staking, ...) this adapter
    // doesn't have specific handling for yet — still surfaced using the
    // element's own top-level USD value rather than silently dropped.
    if (el.value != null && el.value !== 0) {
      holdings.push({
        ticker: `JUP-${label.toUpperCase()}`,
        qty: null,
        usd_override: el.value,
        contract: null,
        category: "defi",
        chain: "solana-defi",
        icon_url: null,
        protocol,
        protocol_url: el.data?.link ?? null,
      });
    }
  }

  return { holdings, warnings };
}

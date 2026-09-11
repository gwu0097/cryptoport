import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const API_BASE = "https://dlmm.datapi.meteora.ag";
const APP_URL = "https://app.meteora.ag/";

interface OpenPositionPool {
  poolAddress: string;
  tokenX?: string;
  tokenY?: string;
  /** Current USD value of this pool's position(s) — a decimal string. */
  balances: string;
}

interface OpenPositionsResponse {
  totalPositions: number;
  pools: OpenPositionPool[];
}

export interface MeteoraPositionsResult {
  holdings: AdapterHolding[];
  warnings: string[];
}

/**
 * Meteora's own public DLMM (concentrated liquidity) API — keyless, CORS-
 * open, verified live against a real wallet (zero open positions at
 * verification time, cross-checked two independent ways: this API and a
 * raw on-chain getProgramAccounts read against the DLMM program agreed).
 * Only covers DLMM — Meteora's Dynamic Vault LP tokens are plain SPL
 * balances this app's regular token sync already picks up, and DAMM
 * (a separate concentrated-liquidity product) isn't covered here; add it
 * only once a real wallet is confirmed to hold a DAMM position worth
 * building against.
 *
 * A DLMM position spans two tokens (tokenX/tokenY) with no single
 * "the" token to report as a real holding, unlike Jupiter Earn or a
 * Kamino single-asset deposit — recorded as one synthetic usd_override
 * holding per pool, same treatment as Kamino's multi-asset liquidity
 * positions.
 */
export async function fetchMeteoraPositions(address: string): Promise<MeteoraPositionsResult> {
  const res = await fetchWithRetry(`${API_BASE}/portfolio/open?user=${address}&page_size=50`);
  if (!res.ok) throw new Error(`Meteora portfolio failed: HTTP ${res.status}`);
  const body: OpenPositionsResponse = await res.json();

  const warnings: string[] = [];
  // Observed quirk in Meteora's own API (not this app's bug): totalPositions
  // can be reported >0 while pools[] comes back empty — flagged rather than
  // silently treated as "definitely zero".
  if (body.totalPositions > 0 && (body.pools ?? []).length === 0) {
    warnings.push(`meteora: API reports ${body.totalPositions} open position(s) but returned no pool detail`);
  }

  const holdings: AdapterHolding[] = (body.pools ?? [])
    .map((pool) => ({ pool, balance: Number(pool.balances) }))
    .filter(({ balance }) => Number.isFinite(balance) && balance !== 0)
    .map(
      ({ balance }): AdapterHolding => ({
        ticker: "METEORA-LP",
        qty: null,
        usd_override: balance,
        contract: null,
        category: "defi",
        chain: "solana-defi",
        icon_url: null,
        protocol: "Meteora DLMM",
        protocol_url: APP_URL,
      }),
    );

  return { holdings, warnings };
}

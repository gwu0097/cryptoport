import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const API_BASE = "https://dlmm.datapi.meteora.ag";
// Meteora's own cross-product portfolio host (found by grepping app.meteora.ag's
// portfolio page JS bundle for its real API calls — not documented anywhere,
// and distinct from the per-product datapi hosts above/below). Covers DLMM +
// DAMM v2 in one call; live-verified via a real wallet (returned real zeros
// for both, matching that wallet's true empty positions in both products).
const PORTFOLIO_BALANCES_URL = "https://portfolio.datapi.meteora.ag/balances";
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

interface PortfolioBalancesResponse {
  damm_v2: { balance_usd: string };
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
 * Also covers DAMM v2 (Meteora's other concentrated-liquidity product) via
 * PORTFOLIO_BALANCES_URL, added after a real gap report (jup.ag showed a
 * DAMM v2 position this app didn't). DAMM v2's own datapi host
 * (damm-v2.datapi.meteora.ag) documents /portfolio/open and /portfolio/total
 * endpoints matching the DLMM shape, but both return real 404s in
 * production (live-verified, not a guess) — not actually deployed despite
 * being in the OpenAPI spec. PORTFOLIO_BALANCES_URL is the one live,
 * working source for a wallet's DAMM v2 exposure, at the cost of only
 * returning one combined total across all of a wallet's DAMM v2 pools
 * (no per-pool breakdown, unlike DLMM's /portfolio/open above).
 *
 * Still not covered: Stake2Earn (formerly "M3M3") — its own OpenAPI spec
 * has no wallet-scoped endpoint at all (only /vault/all, /vault/filter,
 * /vault/{address} with a top-holders leaderboard, no way to query "does
 * this wallet have a position"), and it's absent from
 * PORTFOLIO_BALANCES_URL's response too. The only path to real Stake2Earn
 * data is on-chain (getProgramAccounts against the stake-for-fee program,
 * same shape as skrStaking.ts) — deliberately not built here; flag to the
 * user before taking that on, it's a second real adapter's worth of work
 * for what showed as a small position on jup.ag.
 *
 * Meteora's Dynamic Vault LP tokens are plain SPL balances this app's
 * regular token sync already picks up — not handled here either.
 *
 * A DLMM/DAMM v2 position spans two tokens (tokenX/tokenY) with no single
 * "the" token to report as a real holding, unlike Jupiter Earn or a
 * Kamino single-asset deposit — recorded as one synthetic usd_override
 * holding per pool (DLMM) or per wallet (DAMM v2), same treatment as
 * Kamino's multi-asset liquidity positions.
 */
export async function fetchMeteoraPositions(address: string): Promise<MeteoraPositionsResult> {
  const [dlmmRes, balancesRes] = await Promise.all([
    fetchWithRetry(`${API_BASE}/portfolio/open?user=${address}&page_size=50`),
    fetchWithRetry(`${PORTFOLIO_BALANCES_URL}/${address}`),
  ]);
  if (!dlmmRes.ok) throw new Error(`Meteora DLMM portfolio failed: HTTP ${dlmmRes.status}`);
  if (!balancesRes.ok) throw new Error(`Meteora portfolio balances failed: HTTP ${balancesRes.status}`);
  const body: OpenPositionsResponse = await dlmmRes.json();
  const balances: PortfolioBalancesResponse = await balancesRes.json();

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

  const dammV2Balance = Number(balances.damm_v2?.balance_usd);
  if (Number.isFinite(dammV2Balance) && dammV2Balance !== 0) {
    holdings.push({
      ticker: "METEORA-LP",
      qty: null,
      usd_override: dammV2Balance,
      contract: null,
      category: "defi",
      chain: "solana-defi",
      icon_url: null,
      protocol: "Meteora DAMM v2",
      protocol_url: APP_URL,
    });
  }

  return { holdings, warnings };
}

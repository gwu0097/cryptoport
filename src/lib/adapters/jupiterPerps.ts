import "server-only";
import { fetchWithRetry } from "./http";
import { perpsRows, type JupiterPerpsApiPosition } from "../jupiterPerps";
import type { AdapterHolding } from "./types";

// Jupiter's perps API: the endpoint Jupiter's own CLI reads positions from
// (jup-ag/cli src/clients/PerpsClient.ts). Keyless for reads; a separate host
// from api.jup.ag, so it doesn't share jupiterFetch's rate window. One call
// per Solana wallet sync.
const API = "https://perps-api.jup.ag/v2/positions";
const APP_URL = "https://jup.ag/perps";

/** The protocol name these rows carry — jupiterPositions.ts skips Jupiter's
 * own perps fetcher, and solDefiPositions.ts keeps these rows on failure. */
export const JUPITER_PERPS_PROTOCOL = "Jupiter Perps";

interface PositionsResponse {
  count: number;
  dataList: JupiterPerpsApiPosition[];
}

/**
 * A wallet's open Jupiter Perps positions (jupiterPerps.ts values them).
 * Replaces the perps part of Jupiter's portfolio API, whose perps fetcher
 * failed on every wallet with a perps account — open or closed — for weeks
 * ("Discriminant 225 out of range", since 2026-09-10). Closed positions don't
 * appear. Throws on any failure, so the previous rows are kept.
 */
export async function fetchJupiterPerps(address: string): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const res = await fetchWithRetry(`${API}?walletAddress=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<PositionsResponse>;
  if (!Array.isArray(body.dataList)) throw new Error("unexpected response (no dataList)");
  const { rows, unreadable } = perpsRows(body.dataList);
  // A position we can't value means the account's value is unknown: fail
  // the source so its previous rows stay (carryForward.ts), never save a
  // partial account.
  if (unreadable > 0) throw new Error(`${unreadable} position(s) couldn't be read`);
  return {
    holdings: rows.map((r) => ({
      ticker: r.ticker,
      qty: r.qty,
      usd_override: r.valueUsd,
      contract: null,
      category: "defi",
      chain: "solana-defi",
      icon_url: null,
      protocol: JUPITER_PERPS_PROTOCOL,
      protocol_url: APP_URL,
      protocol_section: "Perpetuals",
      position_side: r.side,
      position_leverage: r.leverage,
      position_entry_price: r.entryPrice,
      position_liquidation_price: r.liquidationPrice,
      position_pnl_usd: r.pnlUsd,
      position_pnl_percent: r.pnlPercent,
    })),
    warnings: [],
  };
}

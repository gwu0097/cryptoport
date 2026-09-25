import "server-only";
import { jupiterFetch } from "./jupiterFetch";
import { predictionRows, type JupiterPredictionApiPosition } from "../jupiterPrediction";
import type { AdapterHolding } from "./types";

// Jupiter's Prediction API (beta, documented at developers.jup.ag/docs/
// prediction). On api.jup.ag, so it goes through jupiterFetch's shared pacer
// and key. One call per Solana wallet sync (more only past PAGE_SIZE
// positions).
const API = "https://api.jup.ag/prediction/v1/positions";
const APP_URL = "https://jup.ag/prediction";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const HEADERS: Record<string, string> = JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};

/** The protocol name these rows carry — jupiterPositions.ts skips Jupiter's
 * portfolio prediction fetcher, and solDefiPositions.ts keeps these rows on
 * failure. */
export const JUPITER_PREDICTION_PROTOCOL = "Jupiter Prediction";

interface PositionsPage {
  data: JupiterPredictionApiPosition[];
  pagination?: { hasNext?: boolean };
}

/**
 * A wallet's Jupiter prediction-market positions (jupiterPrediction.ts values
 * them). Replaces the portfolio API's prediction fetcher, which reported
 * Jupiter's own backend rate limit on most wallets even after a retry
 * (2026-09-25) while this endpoint answered every wallet. Pages are read to
 * the end; any failure throws, so the previous rows are kept.
 */
export async function fetchJupiterPrediction(address: string): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const positions: JupiterPredictionApiPosition[] = [];
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} positions`);
    const params = new URLSearchParams({ ownerPubkey: address, start: String(page * PAGE_SIZE), end: String((page + 1) * PAGE_SIZE) });
    const res = await jupiterFetch(`${API}?${params}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Partial<PositionsPage>;
    if (!Array.isArray(body.data)) throw new Error("unexpected response (no data)");
    positions.push(...body.data);
    if (!body.pagination?.hasNext) break;
  }
  return {
    holdings: predictionRows(positions).map((r) => ({
      // Unique among this wallet's rows; the readable name is display_label.
      ticker: `JUPPM-${r.pubkey.slice(-10)}`,
      qty: r.contracts,
      usd_override: r.valueUsd,
      contract: null,
      category: "defi",
      chain: "solana-defi",
      icon_url: null,
      protocol: JUPITER_PREDICTION_PROTOCOL,
      protocol_url: APP_URL,
      protocol_section: "Prediction",
      display_label: r.label,
      position_pnl_usd: r.pnlUsd,
      position_pnl_percent: r.pnlPercent,
    })),
    warnings: [],
  };
}

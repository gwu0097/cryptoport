import "server-only";
import { fetchWithRetry } from "./http";
import { asterHoldings, type AsterBalance } from "../aster";
import type { AdapterHolding } from "./types";

// Aster (asterdex.com, BNB Chain perps DEX; #3 perp DEX by volume, Sep 2026):
// an address's balances, positions and staking in ONE public, keyless call —
// the JSON-RPC method aster_getBalance on tapi.asterdex.com/info (documented
// at asterdex.github.io/aster-api-website/rpc/endpoints; weight 1). An address
// that never opened an Aster account answers an error "The account does not
// exist": no holdings, not a failure (checked live 2026-09-26). Conversion and
// the rules: ../aster.ts.

const RPC = "https://tapi.asterdex.com/info";
const FUTURES_API = "https://fapi.asterdex.com/fapi/v1";

/** The protocol names Zerion uses for Aster, skipped by the Zerion sync
 * (zerionDefi.ts NATIVELY_COVERED_PROTOCOLS) — this adapter owns it. */
export const ZERION_PROTOCOL_NAMES = ["aster", "asterdex"];

export async function fetchAsterHoldings(address: string): Promise<{ holdings: AdapterHolding[]; warnings: string[] }> {
  const res = await fetchWithRetry(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aster_getBalance", params: [address, "latest"] }),
  });
  if (!res.ok) throw new Error(`Aster balance lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: AsterBalance; error?: { message?: string } };
  if (body.error) {
    if (/account does not exist/i.test(body.error.message ?? "")) return { holdings: [], warnings: [] };
    throw new Error(`Aster balance lookup failed: ${body.error.message ?? "unknown error"}`);
  }
  if (!body.result) throw new Error("Aster balance lookup failed: no result");
  return asterHoldings(body.result);
}

/** Every Aster perp market's MARK price, keyed by symbol ("BTCUSDT"), in one
 * public premiumIndex call (759 markets, 2026-09-26). Used for open
 * positions' live PnL (perpPositions.ts). */
export async function fetchAsterPerpMarks(): Promise<Map<string, { usd: number; change24h: number | null }>> {
  const res = await fetchWithRetry(`${FUTURES_API}/premiumIndex`);
  if (!res.ok) throw new Error(`Aster mark prices failed: HTTP ${res.status}`);
  const rows = (await res.json()) as { symbol: string; markPrice: string }[];
  const out = new Map<string, { usd: number; change24h: number | null }>();
  for (const r of rows) {
    const usd = Number(r.markPrice);
    if (Number.isFinite(usd) && usd > 0) out.set(r.symbol, { usd, change24h: null });
  }
  return out;
}

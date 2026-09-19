import "server-only";
import { createPublicClient, http, formatUnits, encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_BASE = "https://data-api.polymarket.com";
// Matches evmChains.ts's own "matic" entry's RPC — a plain public read, not
// worth threading through the full multi-chain multicall registry (that
// scans every *configured* token across every EVM chain at the wallet's own
// address; this is one specific token at a derived proxy address instead —
// see the doc comment below).
const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
// Polymarket's settlement token as of the April 2026 exchange upgrade — a
// USDC-backed ERC-20 wrapping USDC.e, redeemable 1:1 (live-verified: real
// contract, 6 decimals, same as USDC).
const PUSD_CONTRACT = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as Address;
const PUSD_DECIMALS = 6;

const BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface PolymarketProfile {
  proxyWallet: string;
}

interface PolymarketPosition {
  size: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number; // already a percentage (e.g. 83.6119, not 0.836119)
  title: string;
  outcome: string;
  icon: string | null;
  eventSlug: string;
  conditionId: string;
  outcomeIndex: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetchWithRetry(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Polymarket request failed: HTTP ${res.status} (${url})`);
  return res.json();
}

/**
 * Polymarket trades never happen from a wallet's own EOA — every account
 * gets a deterministic proxy wallet (a Gnosis Safe) that actually holds the
 * collateral and positions (live-verified: Gamma's own /public-profile
 * endpoint returns a *different* proxyWallet than the address passed in,
 * for both a real trader and an address that has genuinely never touched
 * Polymarket — the proxy address is computed unconditionally, not looked up
 * from an existing account). So "has this wallet ever used Polymarket" and
 * "does this wallet have a resolvable proxy address" are different
 * questions — this always resolves the proxy, then treats a proxy with no
 * balance and no positions as "no Polymarket activity," same as every other
 * niche/narrow EVM source in this app (see fetchAxieStaking).
 *
 * Two sections, matching how Polymarket's own app (and DeBank) present an
 * account: Deposit (pUSD collateral, a real ERC-20 balanceOf on Polygon —
 * the Data API has no direct balance endpoint, only marked position value)
 * and Prediction (open positions, valued at `currentValue` — size × the
 * market's current price per share, already the position's real worth if
 * sold, no leverage/margin distinction needed the way a perp position has).
 */
export async function fetchPolymarketHoldings(address: string): Promise<AdapterHolding[]> {
  const profile = await fetchJson<PolymarketProfile>(
    `${GAMMA_BASE}/public-profile?address=${address}`,
  );
  const proxyWallet = profile.proxyWallet as Address;

  const balanceData = encodeFunctionData({ abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [proxyWallet] });
  const client = createPublicClient({ transport: http(POLYGON_RPC) });

  const [positions, balanceResult] = await Promise.all([
    fetchJson<PolymarketPosition[]>(
      `${DATA_BASE}/positions?user=${proxyWallet}&sizeThreshold=0&limit=500`,
    ),
    client.call({ to: PUSD_CONTRACT, data: balanceData }),
  ]);

  const holdings: AdapterHolding[] = [];

  const balanceRaw = balanceResult.data ? (decodeFunctionResult({
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    data: balanceResult.data,
  }) as bigint) : BigInt(0);
  const pusdBalance = Number(formatUnits(balanceRaw, PUSD_DECIMALS));
  if (Number.isFinite(pusdBalance) && pusdBalance > 0) {
    holdings.push({
      ticker: "PUSD",
      qty: pusdBalance,
      usd_override: pusdBalance, // 1:1 USDC-redeemable, same pin pattern as Hyperliquid's stablecoins
      contract: PUSD_CONTRACT,
      category: "defi",
      chain: "polymarket",
      icon_url: null,
      protocol: "Polymarket",
      protocol_url: null,
      protocol_section: "Deposit",
    });
  }

  for (const p of positions) {
    if (!Number.isFinite(p.size) || p.size <= 0) continue;
    if (!Number.isFinite(p.currentValue)) continue;

    holdings.push({
      // Ticker only needs to be unique among this wallet's own positions
      // (not globally) — conditionId + outcomeIndex disambiguates two
      // outcomes (Yes/No) of the same market. The real, human-readable
      // label is display_label below.
      ticker: `POLY-${p.conditionId.slice(-10)}-${p.outcomeIndex}`,
      qty: p.size,
      usd_override: p.currentValue,
      contract: null,
      category: "defi",
      chain: "polymarket",
      icon_url: p.icon || null,
      protocol: "Polymarket",
      protocol_url: `https://polymarket.com/event/${p.eventSlug}`,
      protocol_section: "Prediction",
      display_label: `${p.title} — ${p.outcome}`,
      // Not a leveraged position (position_side stays unset) — cashPnl/
      // percentPnl are still real, signed money on their own, same
      // "informational, not summed into the total" treatment as a perp's
      // PnL (usd_override above is already the position's real current
      // value, not margin, so nothing else needs to account for this).
      position_pnl_usd: Number.isFinite(p.cashPnl) ? p.cashPnl : null,
      position_pnl_percent: Number.isFinite(p.percentPnl) ? p.percentPnl : null,
    });
  }

  return holdings;
}

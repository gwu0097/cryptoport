import "server-only";
import { createPublicClient, http, formatUnits, encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

const RPC_URL = "https://api.roninchain.com/rpc";
// Axie Infinity's own official AXS staking pool on Ronin — verified live via
// a real staked wallet (334.47 staked + 50.38 pending ≈ the 384 AXS this
// app's user had been tracking as a single manual holding), not just
// trusted from a block-explorer label. Contract/function shape (plain
// address-keyed view functions, no ABI library needed) extracted from
// stake.axieinfinity.com's own production JS bundle.
const STAKING_CONTRACT = "0x05b0bb3c1c320b280501b86706c3551995bc8571" as const;
// AXS's real Ronin contract address — confirmed live via CoinGecko's own
// /coins/axie-infinity endpoint (its `platforms.ronin` field), not
// hand-copied from memory.
const AXS_CONTRACT = "0x97a9107c1793bc407d6f527b77e7fff4d812bece";
const AXS_COINGECKO_ID = "axie-infinity";
const APP_URL = "https://stake.axieinfinity.com/";
// Consumed by zerionDefi.ts's NATIVELY_COVERED_PROTOCOLS — see that
// constant's own doc comment. Live-verified via Zerion's own /v1/chains/
// endpoint that Ronin carries `supports_positions: false`, meaning Zerion
// structurally cannot return a staked position here regardless of this
// list — kept anyway as defense-in-depth against that flag changing,
// rather than relying on an external provider's current feature support.
export const ZERION_PROTOCOL_NAMES = ["axie staking"];

const ABI = [
  {
    name: "getStakingAmount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getPendingRewards",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

async function readAmount(
  client: ReturnType<typeof createPublicClient>,
  functionName: "getStakingAmount" | "getPendingRewards",
  address: Address,
): Promise<bigint> {
  const data = encodeFunctionData({ abi: ABI, functionName, args: [address] });
  const result = await client.call({ to: STAKING_CONTRACT, data });
  if (!result.data) return BigInt(0);
  return decodeFunctionResult({ abi: ABI, functionName, data: result.data }) as bigint;
}

/**
 * A wallet's staked AXS position plus its unclaimed staking rewards, on
 * Axie Infinity's own official Ronin staking pool — reported directly:
 * this app's regular EVM sync only reads plain wallet balances
 * (multicallEvm.ts), so a staked position (moved into the staking
 * contract, not held at the wallet's own address) was invisible and had
 * to be tracked as a manual holding instead. Two separate holdings, not
 * one combined figure — staked principal (locked) and pending rewards
 * (claimable) are genuinely different things, same "keep principal and
 * rewards visually distinct" treatment as jitoMevRewards.ts.
 *
 * Priced by its contract ("ronin" + AXS's real contract -> token_registry
 * -> CoinGecko id price_key), the same way as every other EVM contract
 * token — never by ticker, for collision safety.
 */
export async function fetchAxieStaking(address: Address): Promise<AdapterHolding[]> {
  const client = createPublicClient({ transport: http(RPC_URL) });

  const [stakedRaw, rewardsRaw] = await Promise.all([
    readAmount(client, "getStakingAmount", address),
    readAmount(client, "getPendingRewards", address),
  ]);

  if (stakedRaw === BigInt(0) && rewardsRaw === BigInt(0)) return []; // no position — a real $0, not an error

  // A price/icon failure (CoinGecko 429) keeps the position, unpriced —
  // it used to throw and drop 385 AXS from the wallet entirely
  // (2026-09-24).
  // Priced by its asset key after the sync (docs/pricing/PLAN.md) — no
  // sync-time price call.
  const images = await fetchTokenImages([AXS_COINGECKO_ID]).catch(() => new Map<string, string>());
  const icon = images.get(AXS_COINGECKO_ID) ?? null;

  const holdings: AdapterHolding[] = [];
  if (stakedRaw > BigInt(0)) {
    const qty = Number(formatUnits(stakedRaw, 18));
    holdings.push({
      ticker: "AXS",
      qty,
      usd_override: null,
      contract: AXS_CONTRACT,
      category: "defi",
      chain: "ron",
      icon_url: icon,
      protocol: "Axie Staking",
      protocol_url: APP_URL,
      protocol_section: "Staked",
      display_label: "Staked AXS",
    });
  }
  if (rewardsRaw > BigInt(0)) {
    const qty = Number(formatUnits(rewardsRaw, 18));
    holdings.push({
      ticker: "AXS",
      qty,
      usd_override: null,
      contract: AXS_CONTRACT,
      category: "defi",
      chain: "ron",
      icon_url: icon,
      // One protocol with a Rewards section (was its own "Axie Staking
      // Rewards" protocol until 2026-09-25).
      protocol: "Axie Staking",
      protocol_url: APP_URL,
      protocol_section: "Rewards",
      display_label: "Pending rewards",
    });
  }
  return holdings;
}

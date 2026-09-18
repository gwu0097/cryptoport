import "server-only";
import { createPublicClient, http, formatUnits, encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { fetchTokenPrices, fetchTokenImages } from "./coingecko";
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
 * Priced via CoinGecko's contract-keyed lookup (chain.coingeckoPlatform
 * "ronin" + AXS's real contract), the same mechanism multicallEvm.ts uses
 * for every other EVM contract token — never the shared ticker-table path,
 * for the same collision-safety reason every other DeFi-position adapter
 * in this app avoids it.
 */
export async function fetchAxieStaking(address: Address): Promise<AdapterHolding[]> {
  const client = createPublicClient({ transport: http(RPC_URL) });

  const [stakedRaw, rewardsRaw] = await Promise.all([
    readAmount(client, "getStakingAmount", address),
    readAmount(client, "getPendingRewards", address),
  ]);

  if (stakedRaw === BigInt(0) && rewardsRaw === BigInt(0)) return []; // no position — a real $0, not an error

  const [prices, images] = await Promise.all([
    fetchTokenPrices("ronin", [AXS_CONTRACT]),
    fetchTokenImages([AXS_COINGECKO_ID]),
  ]);
  const price = prices.get(AXS_CONTRACT.toLowerCase());
  const icon = images.get(AXS_COINGECKO_ID) ?? null;

  const holdings: AdapterHolding[] = [];
  if (stakedRaw > BigInt(0)) {
    const qty = Number(formatUnits(stakedRaw, 18));
    holdings.push({
      ticker: "AXS",
      qty,
      usd_override: price ? qty * price.usd : null,
      contract: AXS_CONTRACT,
      category: "defi",
      chain: "ron",
      icon_url: icon,
      protocol: "Axie Staking",
      protocol_url: APP_URL,
    });
  }
  if (rewardsRaw > BigInt(0)) {
    const qty = Number(formatUnits(rewardsRaw, 18));
    holdings.push({
      ticker: "AXS",
      qty,
      usd_override: price ? qty * price.usd : null,
      contract: AXS_CONTRACT,
      category: "defi",
      chain: "ron",
      icon_url: icon,
      protocol: "Axie Staking Rewards",
      protocol_url: APP_URL,
    });
  }
  return holdings;
}

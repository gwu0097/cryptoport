import "server-only";
import { createPublicClient, http, formatUnits, encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { EVM_CHAINS } from "./evmChains";
import { fetchTokenPrices, fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// Reused from evmChains.ts's own "eth" entry rather than re-hardcoded here
// (unlike axieStaking.ts's Ronin RPC — Ronin isn't in EVM_CHAINS at all,
// but "eth" already is, so restating its rpc/coingeckoPlatform/
// nativeCoingeckoId here would just be a second copy that could drift).
const ETH_CHAIN = EVM_CHAINS.find((c) => c.id === "eth")!;

// SuperVerse's own official DAO staking contract (mainnet) — reported
// directly ("superverse stake on eth chain that's not showing up"):
// this app's regular EVM sync only reads plain wallet balances
// (multicallEvm.ts), so a staked position (moved into this contract, not
// held at the wallet's own address) was invisible. Address/ABI extracted
// from staking.superverse.co's own production JS bundle (its
// STAKER_ADDRESS constant, live-verified: `VITE_CHAIN_ID:"1"` baked into
// that same bundle confirms it's the mainnet config actually served in
// production, not a leftover testnet default), then cross-checked against
// Etherscan's own verified ABI for this address — both agree. Live-tested
// against 10 real senders to this contract found via recent Etherscan
// transactions; several had real nonzero staked SUPER + claimed/available
// ETH rewards matching what stakerInfo() reported, confirming the
// function/decoding is correct, not just plausible-looking.
const STAKING_CONTRACT = "0x8c96edc82d111e3c5686f5abe738a82d54d0b887" as const;
const SUPER_CONTRACT = "0xe53ec727dbdeb9e2d5456c3be40cff031ab40a55";
// CoinGecko's listing id for SUPER — confirmed live via its own coin page
// (still under the pre-rebrand "superfarm" slug; SuperVerse was formerly
// SuperFarm), not guessed from the current SuperVerse name.
const SUPER_COINGECKO_ID = "superfarm";
const APP_URL = "https://staking.superverse.co/";

const ABI = [
  {
    type: "function",
    name: "stakerInfo",
    inputs: [{ name: "_staker", type: "address" }],
    outputs: [
      { name: "stakerPower", type: "uint256" },
      { name: "stakedTokens", type: "uint256" },
      { name: "claimedReward", type: "uint256" },
      { name: "missedReward", type: "uint256" },
      { name: "availableToClaim", type: "uint256" },
      { name: "idsET", type: "uint256[]" },
      { name: "idsSFs", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
] as const;

/**
 * A wallet's staked SUPER position plus its unclaimed ETH staking rewards
 * (SuperVerse's DAO Staker pays rewards in ETH, not SUPER — real fees/
 * royalties revenue-shared to stakers, per SuperVerse's own docs) — two
 * separate holdings, different tickers, same "keep principal and rewards
 * visually distinct" treatment as axieStaking.ts.
 *
 * SuperVerse's staker also accepts EllioTrades/SuperFarm Genesis NFTs
 * staked alongside SUPER (stakerInfo's idsET/idsSFs — live-confirmed two
 * of the ten real test addresses had nonzero "power" from staked NFTs with
 * zero staked SUPER tokens). Deliberately not surfaced as a holding here:
 * there's no reliable floor-price source already wired into this app for
 * either collection, and a fabricated/guessed NFT value is exactly what
 * the Data Correctness rule forbids — the staked SUPER and ETH rewards
 * (both real, priceable amounts) are still fully captured either way.
 *
 * SUPER priced via CoinGecko's contract-keyed lookup (never the shared
 * ticker table), same mechanism multicallEvm.ts/axieStaking.ts use for
 * every other DeFi-position token, for the same collision-safety reason.
 * The ETH reward amount uses the regular ticker-keyed path (usd_override
 * null) — unlike an arbitrary token symbol, "ETH" carries no realistic
 * collision risk, and every other native-ETH holding in this app already
 * prices the same way.
 */
export async function fetchSuperverseStaking(address: Address): Promise<AdapterHolding[]> {
  const client = createPublicClient({ transport: http(ETH_CHAIN.rpc) });
  const data = encodeFunctionData({ abi: ABI, functionName: "stakerInfo", args: [address] });
  const result = await client.call({ to: STAKING_CONTRACT, data });
  if (!result.data) return [];

  const [, stakedRaw, , , availableRaw] = decodeFunctionResult({
    abi: ABI,
    functionName: "stakerInfo",
    data: result.data,
  });

  if (stakedRaw === BigInt(0) && availableRaw === BigInt(0)) return []; // no position — a real $0, not an error

  const holdings: AdapterHolding[] = [];

  if (stakedRaw > BigInt(0)) {
    const [prices, images] = await Promise.all([
      fetchTokenPrices(ETH_CHAIN.coingeckoPlatform, [SUPER_CONTRACT]),
      fetchTokenImages([SUPER_COINGECKO_ID]),
    ]);
    const price = prices.get(SUPER_CONTRACT.toLowerCase());
    const qty = Number(formatUnits(stakedRaw, 18));
    holdings.push({
      ticker: "SUPER",
      qty,
      usd_override: price ? qty * price.usd : null,
      contract: SUPER_CONTRACT,
      category: "defi",
      chain: ETH_CHAIN.id,
      icon_url: images.get(SUPER_COINGECKO_ID) ?? null,
      protocol: "SuperVerse Staking",
      protocol_url: APP_URL,
    });
  }

  if (availableRaw > BigInt(0)) {
    const images = await fetchTokenImages([ETH_CHAIN.nativeCoingeckoId]);
    const qty = Number(formatUnits(availableRaw, 18));
    holdings.push({
      ticker: ETH_CHAIN.nativeSymbol,
      qty,
      usd_override: null, // priced via the existing ticker-keyed path, same as every other native ETH holding
      contract: null,
      category: "defi",
      chain: ETH_CHAIN.id,
      icon_url: images.get(ETH_CHAIN.nativeCoingeckoId) ?? null,
      protocol: "SuperVerse Staking Rewards",
      protocol_url: APP_URL,
    });
  }

  return holdings;
}

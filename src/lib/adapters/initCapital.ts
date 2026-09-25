import "server-only";
import { createPublicClient, type Address } from "viem";
import { EVM_CHAINS, MULTICALL3_ADDRESS } from "./evmChains";
import { evmTransport } from "./evmTransport";
import { initHoldings, type InitPositionAmounts, type TokenInfo } from "../initCapital";
import type { AdapterHolding } from "./types";

// INIT Capital lending positions, read on-chain (no public per-user API). A
// position is an ERC-721 owned by one of INIT's hook contracts, with the user
// recorded as its viewer, so positions are found through
// PosManager.getViewerPosIds* — never the wallet's own token balances.
// Four multicalls per wallet: how many positions, their ids, their collateral
// and debt shares, then the share → coin conversions plus each coin's
// symbol/decimals. Addresses: docs.init.capital (contract addresses), checked
// live 2026-09-25. Mantle only: Blast's pools hold a rebasing wrapper whose
// unwrap isn't verified yet (BACKLOG.md). Pure conversion: ../initCapital.ts.

const DEPLOYMENTS: { chain: string; posManager: Address }[] = [{ chain: "mnt", posManager: "0x0e7401707CD08c03CDb53DAEF3295DDFb68BBa92" }];

/** The protocol names Zerion uses for INIT Capital, skipped by the Zerion sync
 * (zerionDefi.ts NATIVELY_COVERED_PROTOCOLS) — this adapter owns it. */
export const ZERION_PROTOCOL_NAMES = ["init capital"];

const POS_MANAGER_ABI = [
  { type: "function", name: "getViewerPosIdsLength", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getViewerPosIdsAt", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getPosCollInfo",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address[]" }, { type: "uint256[]" }, { type: "address[]" }, { type: "uint256[][]" }, { type: "uint256[][]" }],
  },
  { type: "function", name: "getPosBorrInfo", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address[]" }, { type: "uint256[]" }] },
] as const;

const POOL_ABI = [
  { type: "function", name: "underlyingToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "toAmt", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "debtShareToAmtStored", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export async function fetchInitCapitalHoldings(address: string): Promise<AdapterHolding[]> {
  const out: AdapterHolding[] = [];
  for (const d of DEPLOYMENTS) {
    const chain = EVM_CHAINS.find((c) => c.id === d.chain);
    if (!chain) continue;
    const client = createPublicClient({ transport: evmTransport(chain) });
    const multicall = <T>(contracts: unknown[]) => client.multicall({ multicallAddress: MULTICALL3_ADDRESS, contracts: contracts as never, allowFailure: false }) as Promise<T[]>;
    const user = address as Address;

    const count = await client.readContract({ address: d.posManager, abi: POS_MANAGER_ABI, functionName: "getViewerPosIdsLength", args: [user] });
    if (count === BigInt(0)) continue;
    const posIds = await multicall<bigint>(
      Array.from({ length: Number(count) }, (_, i) => ({ address: d.posManager, abi: POS_MANAGER_ABI, functionName: "getViewerPosIdsAt", args: [user, BigInt(i)] })),
    );
    const infos = await multicall<unknown>(
      posIds.flatMap((id) => [
        { address: d.posManager, abi: POS_MANAGER_ABI, functionName: "getPosCollInfo", args: [id] },
        { address: d.posManager, abi: POS_MANAGER_ABI, functionName: "getPosBorrInfo", args: [id] },
      ]),
    );
    const raw = posIds.map((id, i) => {
      const [collPools, collShares] = infos[2 * i] as [Address[], bigint[]];
      const [borrPools, debtShares] = infos[2 * i + 1] as [Address[], bigint[]];
      return {
        posId: id.toString(),
        coll: collPools.map((pool, j) => ({ pool, shares: collShares[j] })).filter((c) => c.shares > BigInt(0)),
        borr: borrPools.map((pool, j) => ({ pool, shares: debtShares[j] })).filter((b) => b.shares > BigInt(0)),
      };
    });
    const legs = raw.flatMap((p, pos) => [
      ...p.coll.map((c) => ({ ...c, pos, kind: "coll" as const })),
      ...p.borr.map((b) => ({ ...b, pos, kind: "borr" as const })),
    ]);
    if (legs.length === 0) continue; // only empty positions (withdrawn)

    const pools = [...new Set(legs.map((l) => l.pool.toLowerCase()))] as Address[];
    const [underlyings, amounts] = await Promise.all([
      multicall<Address>(pools.map((pool) => ({ address: pool, abi: POOL_ABI, functionName: "underlyingToken" }))),
      multicall<bigint>(legs.map((l) => ({ address: l.pool, abi: POOL_ABI, functionName: l.kind === "coll" ? "toAmt" : "debtShareToAmtStored", args: [l.shares] }))),
    ]);
    const underlyingOf = new Map<string, string>(pools.map((p, i) => [p, underlyings[i].toLowerCase()]));
    const coins = [...new Set(underlyings.map((u) => u.toLowerCase()))] as Address[];
    const meta = await multicall<string | number>(coins.flatMap((c) => [
      { address: c, abi: ERC20_ABI, functionName: "symbol" },
      { address: c, abi: ERC20_ABI, functionName: "decimals" },
    ]));
    const tokens = new Map<string, TokenInfo>(coins.map((c, i) => [c.toLowerCase(), { symbol: String(meta[2 * i]), decimals: Number(meta[2 * i + 1]) }]));

    const leg = (l: (typeof legs)[number], i: number) => ({ underlying: underlyingOf.get(l.pool.toLowerCase())!, amount: amounts[i] });
    const positions: InitPositionAmounts[] = raw.map((p, pos) => ({
      posId: p.posId,
      collateral: legs.flatMap((l, i) => (l.pos === pos && l.kind === "coll" ? [leg(l, i)] : [])),
      borrows: legs.flatMap((l, i) => (l.pos === pos && l.kind === "borr" ? [leg(l, i)] : [])),
    }));
    out.push(...initHoldings(d.chain, positions, tokens));
  }
  return out;
}

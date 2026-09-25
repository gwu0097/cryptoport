import "server-only";
import { createPublicClient, formatUnits, isAddress, type Address } from "viem";
import { EVM_CHAINS, MULTICALL3_ADDRESS } from "./evmChains";
import { evmTransport } from "./multicallEvm";
import type { VaultClaim } from "../receiptDedupe";

// What each candidate vault share token the wallet holds is worth in its
// underlying coin, read on-chain via the ERC-4626 standard (Morpho, Yearn,
// Euler, Spark …) — so a vault position Zerion reports without a pool
// address can be matched to the share token exactly (receiptDedupe.ts
// linkVaultPositions). Two multicalls per chain with candidates: asset() +
// balanceOf(owner), then convertToAssets(shares) + the asset's decimals. A
// token that isn't a vault fails asset() and is skipped; any failure yields
// no claim (never a guess).

const VAULT_ABI = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export async function readVaultClaims(owner: string, candidates: readonly { chain: string | null; contract: string | null }[]): Promise<VaultClaim[]> {
  const byChain = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!c.chain || !c.contract || !isAddress(c.contract)) continue;
    byChain.set(c.chain, (byChain.get(c.chain) ?? new Set()).add(c.contract.toLowerCase()));
  }
  const perChain = await Promise.all(
    [...byChain].map(async ([chainId, contracts]) => {
      const chain = EVM_CHAINS.find((c) => c.id === chainId);
      if (!chain) return [];
      try {
        const client = createPublicClient({ transport: evmTransport(chain) });
        const vaults = [...contracts] as Address[];
        const first = await client.multicall({
          multicallAddress: MULTICALL3_ADDRESS,
          contracts: vaults.flatMap((v) => [
            { address: v, abi: VAULT_ABI, functionName: "asset" } as const,
            { address: v, abi: VAULT_ABI, functionName: "balanceOf", args: [owner as Address] } as const,
          ]),
        });
        const found = vaults
          .map((vault, i) => ({ vault, asset: first[2 * i], shares: first[2 * i + 1] }))
          .filter((x) => x.asset.status === "success" && x.shares.status === "success" && (x.shares.result as bigint) > BigInt(0))
          .map((x) => ({ vault: x.vault, asset: x.asset.result as Address, shares: x.shares.result as bigint }));
        if (found.length === 0) return [];
        const second = await client.multicall({
          multicallAddress: MULTICALL3_ADDRESS,
          contracts: found.flatMap((f) => [
            { address: f.vault, abi: VAULT_ABI, functionName: "convertToAssets", args: [f.shares] } as const,
            { address: f.asset, abi: VAULT_ABI, functionName: "decimals" } as const,
          ]),
        });
        return found.flatMap((f, i): VaultClaim[] => {
          const assets = second[2 * i];
          const decimals = second[2 * i + 1];
          if (assets.status !== "success" || decimals.status !== "success") return [];
          return [{ chain: chainId, vault: f.vault.toLowerCase(), asset: f.asset.toLowerCase(), assets: Number(formatUnits(assets.result as bigint, Number(decimals.result))) }];
        });
      } catch {
        return []; // chain unreachable or no Multicall3: no claims, both rows stay
      }
    }),
  );
  return perChain.flat();
}

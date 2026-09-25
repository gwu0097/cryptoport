import "server-only";
import { createPublicClient, formatUnits, isAddress, type Address } from "viem";
import { EVM_CHAINS, MULTICALL3_ADDRESS } from "./evmChains";
import { evmTransport } from "./multicallEvm";
import type { ReceiptClaim } from "../receiptDedupe";

// What each held token is worth in its underlying coin, when it's a standard
// DeFi receipt — read on-chain, so a Zerion position can be matched to the
// receipt the wallet holds exactly (receiptDedupe.ts linkReceiptPositions).
// Tried in this order, all in one multicall per chain (a token that isn't a
// receipt just fails every probe):
//   ERC-4626 vault      asset()                    → convertToAssets(balance)
//   Aave v2/v3 aToken   UNDERLYING_ASSET_ADDRESS() → balance (1:1; forks too)
//   Compound v3 Comet   baseToken()                → balance (1:1)
//   Compound v2 cToken  underlying()               → balance × exchangeRateStored() / 1e18
// A second multicall reads the conversion (4626 / cToken) and the underlying
// coin's decimals. Any failure yields no claim for that token — never a guess.

const ABI = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "UNDERLYING_ASSET_ADDRESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "baseToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "exchangeRateStored", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

type Kind = "erc4626" | "aave" | "comet" | "ctoken";
const PROBES: { kind: Kind; fn: "asset" | "UNDERLYING_ASSET_ADDRESS" | "baseToken" | "underlying" }[] = [
  { kind: "erc4626", fn: "asset" },
  { kind: "aave", fn: "UNDERLYING_ASSET_ADDRESS" },
  { kind: "comet", fn: "baseToken" },
  { kind: "ctoken", fn: "underlying" },
];

type Result = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

export async function readReceiptClaims(owner: string, tokens: readonly { chain: string | null; contract: string | null }[]): Promise<ReceiptClaim[]> {
  const byChain = new Map<string, Set<string>>();
  for (const t of tokens) {
    if (!t.chain || !t.contract || !isAddress(t.contract)) continue;
    byChain.set(t.chain, (byChain.get(t.chain) ?? new Set()).add(t.contract.toLowerCase()));
  }
  const perChain = await Promise.all(
    [...byChain].map(async ([chainId, contracts]) => {
      const chain = EVM_CHAINS.find((c) => c.id === chainId);
      if (!chain) return [];
      try {
        const client = createPublicClient({ transport: evmTransport(chain) });
        const call = (calls: unknown[]) => client.multicall({ multicallAddress: MULTICALL3_ADDRESS, contracts: calls as never }) as Promise<Result[]>;
        const list = [...contracts] as Address[];
        const per = PROBES.length + 1; // the probes + balanceOf
        const first = await call(
          list.flatMap((t) => [
            ...PROBES.map((p) => ({ address: t, abi: ABI, functionName: p.fn })),
            { address: t, abi: ABI, functionName: "balanceOf", args: [owner as Address] },
          ]),
        );
        const found = list.flatMap((token, i) => {
          const r = first.slice(i * per, (i + 1) * per);
          const balance = r[PROBES.length];
          if (balance.status !== "success" || (balance.result as bigint) <= BigInt(0)) return [];
          const hit = PROBES.findIndex((_, j) => {
            const probe = r[j];
            return probe.status === "success" && isAddress(String(probe.result));
          });
          if (hit === -1) return [];
          return [{ token, kind: PROBES[hit].kind, asset: (r[hit] as { result: Address }).result, balance: balance.result as bigint }];
        });
        if (found.length === 0) return [];
        // Per receipt: [conversion (4626 / cToken) or its own decimals, the underlying's decimals].
        const second = await call(
          found.flatMap((f) => [
            f.kind === "erc4626"
              ? { address: f.token, abi: ABI, functionName: "convertToAssets", args: [f.balance] }
              : f.kind === "ctoken"
                ? { address: f.token, abi: ABI, functionName: "exchangeRateStored" }
                : { address: f.token, abi: ABI, functionName: "decimals" },
            { address: f.asset, abi: ABI, functionName: "decimals" },
          ]),
        );
        return found.flatMap((f, i): ReceiptClaim[] => {
          const [conv, assetDecimals] = [second[2 * i], second[2 * i + 1]];
          if (conv.status !== "success" || assetDecimals.status !== "success") return [];
          const raw =
            f.kind === "erc4626"
              ? (conv.result as bigint)
              : f.kind === "ctoken"
                ? (f.balance * (conv.result as bigint)) / BigInt(10) ** BigInt(18)
                : f.balance; // aToken / Comet balances are the underlying amount, in the underlying's decimals
          return [{ chain: chainId, receipt: f.token.toLowerCase(), asset: f.asset.toLowerCase(), assets: Number(formatUnits(raw, Number(assetDecimals.result))) }];
        });
      } catch {
        return []; // chain unreachable or no Multicall3: no claims, both rows stay
      }
    }),
  );
  return perChain.flat();
}

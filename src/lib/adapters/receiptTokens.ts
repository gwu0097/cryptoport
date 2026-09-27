import "server-only";
import { createPublicClient, formatUnits, isAddress, type Address } from "viem";
import { EVM_CHAINS, MULTICALL3_ADDRESS } from "./evmChains";
import { evmTransport } from "./evmTransport";
import type { ReceiptClaim } from "../receiptDedupe";
import { claimBelievable, provenReceipt, type ReceiptKind } from "../receiptChecks";

// What each held token is worth in its underlying coin, when it's a standard
// DeFi receipt — read on-chain, so a Zerion position can be matched to the
// receipt the wallet holds exactly (receiptDedupe.ts linkReceiptPositions).
// Tried in this order, all in one multicall per chain (a token that isn't a
// receipt just fails every probe). Each needs a second, standard-specific
// answer (receiptChecks.ts — one function is never proof):
//   ERC-4626 vault      asset() + totalAssets()    → convertToAssets(balance)
//   Aave v2/v3 aToken   UNDERLYING_ASSET_ADDRESS() → balance (1:1; forks too),
//                       only if it also answers RESERVE_TREASURY_ADDRESS()
//   Compound v3 Comet   baseToken() + baseTokenPriceFeed() + getUtilization()
//                                                  → balance (1:1)
//   Compound v2 cToken  underlying()               → balance × exchangeRateStored() / 1e18
// A second multicall reads the conversion (4626 / cToken), the underlying
// coin's decimals and its total supply; a claim above that supply (or above a
// vault's totalAssets) is rejected. Any failure yields no claim for that
// token — never a guess.
// A debt token is never a claim: Aave's variable/stable debt tokens answer
// UNDERLYING_ASSET_ADDRESS() exactly like an aToken, but they also answer
// borrowAllowance(), which is part of the debt-token interface
// (ICreditDelegationToken) and which aTokens don't have; aTokens answer
// RESERVE_TREASURY_ADDRESS(), which debt tokens don't (checked live on Aave
// v3 Arbitrum, Mode, Taiko and Avalanche, 2026-09-25). Counting one would
// turn a loan into a holding (variableDebtWrsETH on Mode showed as +$3).

const ABI = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "UNDERLYING_ASSET_ADDRESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "baseToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "exchangeRateStored", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "RESERVE_TREASURY_ADDRESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "borrowAllowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "baseTokenPriceFeed", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getUtilization", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

type Kind = ReceiptKind;
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
        // The probes, balanceOf, then the proofs: aToken treasury, debt-token
        // allowance, vault totalAssets, Comet price feed and utilization.
        const per = PROBES.length + 6;
        const first = await call(
          list.flatMap((t) => [
            ...PROBES.map((p) => ({ address: t, abi: ABI, functionName: p.fn })),
            { address: t, abi: ABI, functionName: "balanceOf", args: [owner as Address] },
            { address: t, abi: ABI, functionName: "RESERVE_TREASURY_ADDRESS" },
            { address: t, abi: ABI, functionName: "borrowAllowance", args: [owner as Address, owner as Address] },
            { address: t, abi: ABI, functionName: "totalAssets" },
            { address: t, abi: ABI, functionName: "baseTokenPriceFeed" },
            { address: t, abi: ABI, functionName: "getUtilization" },
          ]),
        );
        const ok = (x: Result) => x.status === "success";
        const addr = (x: Result) => (x.status === "success" && isAddress(String(x.result)) ? String(x.result) : null);
        const found = list.flatMap((token, i) => {
          const r = first.slice(i * per, (i + 1) * per);
          const n = PROBES.length;
          const balance = r[n];
          if (balance.status !== "success" || (balance.result as bigint) <= BigInt(0)) return [];
          const proven = provenReceipt({
            erc4626: addr(r[0]),
            aave: addr(r[1]),
            comet: addr(r[2]),
            ctoken: addr(r[3]),
            aTokenProof: ok(r[n + 1]),
            isDebtToken: ok(r[n + 2]),
            vaultProof: ok(r[n + 3]),
            cometProof: ok(r[n + 4]) && ok(r[n + 5]),
          });
          if (!proven) return [];
          const totalAssets = r[n + 3].status === "success" ? (r[n + 3] as { result: bigint }).result : null;
          return [{ token, kind: proven.kind, asset: proven.asset as Address, balance: balance.result as bigint, totalAssets }];
        });
        if (found.length === 0) return [];
        // Per receipt: [conversion (4626 / cToken) or its own decimals, the
        // underlying's decimals, the underlying's total supply].
        const second = await call(
          found.flatMap((f) => [
            f.kind === "erc4626"
              ? { address: f.token, abi: ABI, functionName: "convertToAssets", args: [f.balance] }
              : f.kind === "ctoken"
                ? { address: f.token, abi: ABI, functionName: "exchangeRateStored" }
                : { address: f.token, abi: ABI, functionName: "decimals" },
            { address: f.asset, abi: ABI, functionName: "decimals" },
            { address: f.asset, abi: ABI, functionName: "totalSupply" },
          ]),
        );
        return found.flatMap((f, i): ReceiptClaim[] => {
          const [conv, assetDecimals, supply] = [second[3 * i], second[3 * i + 1], second[3 * i + 2]];
          if (conv.status !== "success" || assetDecimals.status !== "success") return [];
          const raw =
            f.kind === "erc4626"
              ? (conv.result as bigint)
              : f.kind === "ctoken"
                ? (f.balance * (conv.result as bigint)) / BigInt(10) ** BigInt(18)
                : f.balance; // aToken / Comet balances are the underlying amount, in the underlying's decimals
          const underlyingSupply = supply.status === "success" ? (supply.result as bigint) : null;
          if (!claimBelievable(raw, { underlyingSupply, vaultTotalAssets: f.totalAssets }, f.kind)) return [];
          return [{ chain: chainId, receipt: f.token.toLowerCase(), asset: f.asset.toLowerCase(), assets: Number(formatUnits(raw, Number(assetDecimals.result))) }];
        });
      } catch {
        return []; // chain unreachable or no Multicall3: no claims, both rows stay
      }
    }),
  );
  return perChain.flat();
}

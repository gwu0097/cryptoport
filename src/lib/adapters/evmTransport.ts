import "server-only";
import { http, fallback } from "viem";
import type { EvmChain } from "./evmChains";

/** The chain's RPC, plus its fallbacks when it has any (see
 * EvmChain.fallbackRpcs): a request the primary errors or times out on goes
 * to the next one. Shared by every on-chain reader (the balance scan,
 * receiptTokens.ts, initCapital.ts). */
export function evmTransport(chain: EvmChain) {
  return chain.fallbackRpcs?.length ? fallback([chain.rpc, ...chain.fallbackRpcs].map((url) => http(url))) : http(chain.rpc);
}

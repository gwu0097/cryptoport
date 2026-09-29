import "server-only";
import { http, fallback } from "viem";
import type { EvmChain } from "./evmChains";

/** The chain's RPC, plus its fallbacks when it has any (see
 * EvmChain.fallbackRpcs): a request the primary errors or times out on goes
 * to the next one. Shared by every on-chain reader (the balance scan,
 * receiptTokens.ts, initCapital.ts). */
export function evmTransport(chain: EvmChain) {
  // A call that hasn't answered in 10 s is tried once more, then given up
  // (viem's default is 3 retries: ~40 s for one stalled node, which held a
  // Wallet Watch read for minutes on 2026-09-29).
  const rpc = (url: string) => http(url, { timeout: 10_000, retryCount: 1 });
  return chain.fallbackRpcs?.length ? fallback([chain.rpc, ...chain.fallbackRpcs].map(rpc)) : rpc(chain.rpc);
}

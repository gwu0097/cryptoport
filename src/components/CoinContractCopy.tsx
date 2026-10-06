"use client";

import { CopyButton } from "./CopyButton";
import type { CoinContract } from "@/lib/coinContracts";

/** Copy a coin's token address (coinContracts.ts): the first one
 * (Ethereum first), the others named in the tooltip. Nothing when the coin
 * has no address that can be copied as is. */
export function CoinContractCopy({ ticker, contracts }: { ticker: string; contracts: readonly CoinContract[] }) {
  const first = contracts[0];
  if (!first) return null;
  const others = contracts.slice(1).map((c) => c.chainName);
  const more = others.length ? `\nAlso on ${others.join(", ")}` : "";
  return <CopyButton value={first.contract} label={`Copy ${ticker}'s contract on ${first.chainName}`} title={`Copy ${ticker}'s contract on ${first.chainName}: ${first.contract}${more}`} />;
}

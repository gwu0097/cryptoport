// One short line per destination (transferMatch.ts), as the Analytics
// panel shows it after a coin's quantity change. Pure.

import { chainDisplayName } from "../chainNames.ts";
import { formatQty } from "../format.ts";
import type { Destination, Proceeds } from "./transferMatch.ts";

const proceeds = (p: Proceeds, withChain: boolean) =>
  `${formatQty(p.amount)} ${p.ticker}${withChain ? ` on ${chainDisplayName(p.chain)}` : ""}${p.then ? ` → ${p.then}` : ""}`;

/** `amountOf`: prefix each line with the amount it covers (a coin that went
 * several places). */
export function destinationText(d: Destination, ticker: string, amountOf = false): string {
  const of = amountOf ? `${formatQty(d.amount)} ${ticker} ` : "";
  switch (d.kind) {
    case "trade":
      return `${of}→ ${d.into.map((p) => proceeds(p, false)).join(" + ")}`;
    case "crossChainSwap":
      return `${of}→ ${proceeds(d.into, true)}`;
    case "moved":
      return `${of}→ ${d.toWalletName}`;
    case "destination":
      return `${of}→ ${d.label}`;
    case "sent":
      return d.to ? `${of}sent to ${d.to}` : `${of}sent out (recipient not recorded)`;
    case "unknown":
      return `${of}where it went: not in synced history`;
  }
}

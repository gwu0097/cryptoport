import "server-only";
import { bech32 } from "@scure/base";

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The address to send a Cosmos SDK chain's APIs, which only accept its bech32
 * form. `hexAccounts` chains (Injective) use Ethereum-style keys: the 0x
 * address a Ledger or MetaMask shows and the inj1… address Keplr shows are
 * the same 20 bytes in two encodings, so a 0x address converts losslessly.
 * (Reported 2026-09-24: a Ledger INJ wallet saved as 0x… failed every sync
 * with "Injective balances failed: HTTP 400"; its inj1 form returned the real
 * 30.79 INJ.) Anything that's neither form throws a clear error instead of
 * letting the API answer with a bare 400. See cosmosAddress.test.ts.
 */
export function toBech32Address(address: string, prefix: string, hexAccounts: boolean): string {
  const a = address.trim();
  if (hexAccounts && HEX_ADDRESS_RE.test(a)) {
    const bytes = Uint8Array.from(a.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
    return bech32.encode(prefix, bech32.toWords(bytes));
  }
  try {
    if (bech32.decode(a as `${string}1${string}`, false).prefix === prefix) return a;
  } catch {
    // fall through to the error below
  }
  throw new Error(`Not a valid ${prefix} address — expected ${prefix}1…${hexAccounts ? " or a 0x… address" : ""}`);
}

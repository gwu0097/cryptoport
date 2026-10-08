// A wallet address as typed or pasted, cleaned before it's saved (owner
// 2026-10-08: a Hyperliquid sub-account pasted as "HL:0xdde3…" was saved as
// is, and the sync then failed on all 40 EVM chains with an unreadable wall
// of errors). Pure.
//
// The prefix is EIP-3770's chain-specific address format
// ("<shortName>:<address>": eth:0x…, arb1:0x…, and Hyperliquid's HL:0x…):
// the address is the part after it. Only stripped from an EVM address — a
// colon in anything else is left for its own chain's rules.

const EIP3770 = /^[A-Za-z][A-Za-z0-9-]{0,19}:(0x[0-9a-fA-F]{40})$/;
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Trimmed, with an EIP-3770 chain prefix removed ("HL:0xabc…" → "0xabc…"). */
export function cleanAddressInput(raw: string): string {
  const a = raw.trim();
  const m = a.match(EIP3770);
  return m ? m[1] : a;
}

/** Why an address can't be synced as an EVM wallet; null when it can. */
export function evmAddressProblem(address: string | null): string | null {
  if (!address) return "An auto-synced wallet needs an address.";
  if (EVM_ADDRESS.test(address)) return null;
  return `"${address.length > 50 ? `${address.slice(0, 47)}…` : address}" isn't an EVM address — it should be 0x followed by 40 letters and digits.`;
}

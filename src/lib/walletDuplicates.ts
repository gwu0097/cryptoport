// The duplicate check for adding or editing a wallet (owner 2026-10-09: "why
// is the same account in here twice? I thought there was a dupe catcher" —
// there wasn't; BizCash was counted twice in every total). Pure.
//
// Two wallets are the same when they read the same address: an EVM address
// compared without case (0xB3Fe… = 0xb3fe…) and across EVM chain labels (an
// EVM wallet scans every EVM chain, whatever its label); any other address
// exactly (Solana's and Bitcoin's case matters) on the same chain.

export interface WalletKey {
  id: string;
  name: string;
  chain: string;
  address: string | null;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;

/** The existing wallet `candidate` would duplicate (skipping `exceptId`, the
 * wallet being edited), or null. `isEvmChain` names the EVM chain labels. */
export function duplicateOf(
  candidate: { chain: string; address: string | null },
  existing: readonly WalletKey[],
  isEvmChain: (chain: string) => boolean,
  exceptId?: string,
): WalletKey | null {
  const address = candidate.address?.trim();
  if (!address) return null;
  const evm = EVM.test(address) && isEvmChain(candidate.chain);
  for (const w of existing) {
    if (w.id === exceptId || !w.address) continue;
    const other = w.address.trim();
    if (evm) {
      if (EVM.test(other) && isEvmChain(w.chain) && other.toLowerCase() === address.toLowerCase()) return w;
    } else if (w.chain.toUpperCase() === candidate.chain.toUpperCase() && other === address) {
      return w;
    }
  }
  return null;
}

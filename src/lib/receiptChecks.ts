// Whether a token that answers a DeFi-receipt function really is that
// receipt, and whether its claim is believable. Pure; the on-chain reads are
// in adapters/receiptTokens.ts. (docs/pricing/ILLIQUID.md, part A.)
//
// One function is never proof: "Bera the Cub", a Berachain meme token,
// answers Compound v3's baseToken() with WBERA and was valued as 1,010,069
// WBERA (~$236K) in three wallets (2026-09-26) while holding none. Each
// standard now needs a second answer only that standard gives, and no claim
// may exceed what exists of the underlying coin.

export type ReceiptKind = "erc4626" | "aave" | "comet" | "ctoken";

export interface ProbeAnswers {
  /** The underlying address each standard's function returned, or null. */
  erc4626: string | null;
  aave: string | null;
  comet: string | null;
  ctoken: string | null;
  /** Aave aTokens answer RESERVE_TREASURY_ADDRESS(). */
  aTokenProof: boolean;
  /** Aave debt tokens answer borrowAllowance(): a loan, never a holding. */
  isDebtToken: boolean;
  /** ERC-4626 vaults answer totalAssets(). */
  vaultProof: boolean;
  /** Compound v3 markets answer baseTokenPriceFeed() and getUtilization(). */
  cometProof: boolean;
}

/** Which receipt standard the answers prove, in probe order, or null. */
export function provenReceipt(a: ProbeAnswers): { kind: ReceiptKind; asset: string } | null {
  if (a.isDebtToken) return null;
  if (a.erc4626 && a.vaultProof) return { kind: "erc4626", asset: a.erc4626 };
  if (a.aave && a.aTokenProof) return { kind: "aave", asset: a.aave };
  if (a.comet && a.cometProof) return { kind: "comet", asset: a.comet };
  if (a.ctoken) return { kind: "ctoken", asset: a.ctoken };
  return null;
}

/** A claim (in the underlying's base units) is believable when it doesn't
 * exceed the underlying's total supply and, for a vault, the vault's own
 * total assets. An unreadable bound rejects the claim — never a guess. */
export function claimBelievable(claim: bigint, bounds: { underlyingSupply: bigint | null; vaultTotalAssets?: bigint | null }, kind: ReceiptKind): boolean {
  if (bounds.underlyingSupply === null || claim > bounds.underlyingSupply) return false;
  if (kind === "erc4626") return bounds.vaultTotalAssets != null && claim <= bounds.vaultTotalAssets;
  return true;
}

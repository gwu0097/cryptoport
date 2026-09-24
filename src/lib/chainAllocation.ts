// Portfolio value by chain, split by asset type (Available / Staked /
// Rewards / DeFi) — the Assets page's "Chain allocation" panel, modeled on
// Keplr's "Asset Type Distribution per Chain". Pure (no DB, no network).
//
// Built from the same AssetGroup rows the Coin allocation chart already
// uses, so the two panels always add up to the same total. Unpriced
// holdings contribute no value (missing ≠ 0); each chain counts them so the
// panel can say so instead of hiding them.

export const ASSET_TYPES = ["Available", "Staked", "Rewards", "DeFi"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export interface AllocationHolding {
  chainId: string;
  chainName: string;
  category: string;
  protocol: string | null;
  protocol_section: string | null;
  valuation: { kind: "priced"; usd: number } | { kind: "unpriced" };
}

export interface ChainAllocation {
  chainId: string;
  chainName: string;
  total: number;
  byType: Record<AssetType, number>;
  unpricedCount: number;
}

/** A plain balance is Available; a DeFi row is Staked, Rewards or (lending,
 * LP, vaults, perps, ...) DeFi — read from the section/protocol names the
 * adapters write ("Staked"/"Unbonding"/"Rewards" sections; "Axie Staking",
 * "Solana Staking: …", "Sui native staking", "Axie Staking Rewards", …). */
export function assetTypeOf(h: Pick<AllocationHolding, "category" | "protocol" | "protocol_section">): AssetType {
  if (h.category !== "defi") return "Available";
  const section = h.protocol_section ?? "";
  const protocol = h.protocol ?? "";
  if (section === "Rewards" || /reward/i.test(protocol)) return "Rewards";
  if (section === "Staked" || section === "Unbonding" || /stak/i.test(protocol)) return "Staked";
  return "DeFi";
}

// Solana's DeFi positions are stored under their own "solana-defi" chain id
// (the wallet page lists them separately); by chain they're Solana.
const MERGED_CHAINS: Record<string, { chainId: string; chainName: string }> = {
  "solana-defi": { chainId: "solana", chainName: "Solana" },
};

export function chainAllocations(holdings: AllocationHolding[]): ChainAllocation[] {
  const byChain = new Map<string, ChainAllocation>();
  for (const h of holdings) {
    const { chainId, chainName } = MERGED_CHAINS[h.chainId] ?? h;
    let c = byChain.get(chainId);
    if (!c) {
      c = { chainId, chainName, total: 0, byType: { Available: 0, Staked: 0, Rewards: 0, DeFi: 0 }, unpricedCount: 0 };
      byChain.set(chainId, c);
    }
    if (MERGED_CHAINS[h.chainId] === undefined) c.chainName = chainName;
    if (h.valuation.kind === "unpriced") {
      c.unpricedCount++;
      continue;
    }
    c.total += h.valuation.usd;
    c.byType[assetTypeOf(h)] += h.valuation.usd;
  }
  return [...byChain.values()].sort((a, b) => b.total - a.total);
}

/** The top `max` chains with any value, and the rest (for the Other row;
 * empty when nothing is left over). Chains with only unpriced holdings have
 * no value to rank and are in neither. */
export function topChains(all: ChainAllocation[], max: number): { top: ChainAllocation[]; rest: ChainAllocation[] } {
  const priced = all.filter((c) => c.total > 0);
  return { top: priced.slice(0, max), rest: priced.slice(max) };
}

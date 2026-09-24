// The DeFi page's Staking filter: native staking only — coins delegated to a
// validator on the chain itself, managed from a wallet, with the chain's
// unbonding period. App contracts that "stake" a token (Axie Staking,
// Jupiter DAO, Kamino's KMNO, SKR, Wormhole) are DeFi, and so are liquid
// staking tokens (they're tokens; a deposited one shows under the app it's
// deposited in). Pure (no DB, no network).
//
// Keyed by what the native-staking adapters write: every Cosmos-scan DeFi
// row (auto_cosmos — delegations, rewards, unbonding), and the
// "<Chain> native staking" protocol the Sei, Sui and Solana adapters use.
// "Solana Staking: …" / "Jito MEV Rewards: …" are the names those two Solana
// adapters wrote before 2026-09-25; rows keep them until the wallet's next
// sync.

export type StakingFamily = "cosmos" | "sei" | "sui" | "solana";

export function stakingFamily(h: { source: string; protocol: string | null; chain: string | null }): StakingFamily | null {
  const protocol = h.protocol ?? "";
  if (h.chain === "sei" && (h.source === "auto_cosmos" || protocol === "Sei native staking")) return "sei";
  if (h.source === "auto_cosmos" && protocol) return "cosmos";
  if (protocol === "Sui native staking") return "sui";
  if (protocol === "Solana native staking" || protocol.startsWith("Solana Staking: ") || protocol.startsWith("Jito MEV Rewards: ")) {
    return "solana";
  }
  return null;
}

export interface StakingLinks {
  /** Where to stake/unstake; null when it's done in the wallet app itself. */
  manage: { label: string; url: string } | null;
  guide: { label: string; url: string };
}

// Every URL here was checked to load (2026-09-25). A Cosmos chain's own
// manage link is its Keplr Dashboard page, verified per chain at sync time
// and stored as the position's protocol_url (adapters/cosmosMulti.ts) —
// passed in as `positionUrl`.
export function stakingLinks(family: StakingFamily, positionUrl: string | null): StakingLinks {
  switch (family) {
    case "cosmos":
      return {
        manage: positionUrl?.startsWith("https://wallet.keplr.app/") ? { label: "Manage in Keplr", url: positionUrl } : null,
        guide: {
          label: "How to unstake",
          url: "https://help.keplr.app/general-faq/5R3bMyjtr3tXNeJo8ojSDV/staking-and-unstaking/5So5gM41LhR6PfDSbBfvwV",
        },
      };
    case "sei":
      return {
        manage: { label: "Manage on Sei", url: "https://dashboard.sei.io/stake" },
        guide: { label: "How to unstake", url: "https://docs.sei.io/learn/general-staking" },
      };
    case "sui":
      return {
        manage: { label: "Manage in Slush", url: "https://slush.app/" },
        guide: { label: "How to unstake", url: "https://help.p2p.org/en/articles/10495294-sui-staking-with-slush-browser-extension" },
      };
    case "solana":
      return {
        manage: null,
        guide: { label: "How to unstake", url: "https://help.phantom.com/hc/en-us/articles/4406379741843-How-to-unstake-SOL-in-Phantom" },
      };
  }
}

export type DefiView = "all" | "defi" | "staking";

/** A protocol group is Staking when every position in it is native staking
 * (native-staking protocols only ever hold such rows). */
export function groupFamily(positions: { source: string; protocol: string | null; chain: string | null }[]): StakingFamily | null {
  const families = new Set(positions.map(stakingFamily));
  const [only] = families;
  return families.size === 1 ? only : null;
}

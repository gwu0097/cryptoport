import test from "node:test";
import assert from "node:assert/strict";
import { stakingFamily, groupFamily, stakingLinks } from "./nativeStaking.ts";

const h = (source: string, protocol: string | null, chain: string | null) => ({ source, protocol, chain });

test("native staking = validator delegation; app staking contracts and everything else are DeFi", () => {
  assert.equal(stakingFamily(h("auto_cosmos", "Cosmos Hub native staking", "cosmoshub")), "cosmos");
  assert.equal(stakingFamily(h("auto_cosmos", "Cosmos Hub staking", "cosmoshub")), "cosmos", "pre-rename rows");
  assert.equal(stakingFamily(h("auto_cosmos", "Sei native staking", "sei")), "sei");
  assert.equal(stakingFamily(h("auto", "Sei native staking", "sei")), "sei");
  assert.equal(stakingFamily(h("auto", "Sui native staking", "sui")), "sui");
  assert.equal(stakingFamily(h("auto", "Solana native staking", "solana-defi")), "solana");
  assert.equal(stakingFamily(h("auto", "Solana Staking: Helius (6.9% APY)", "solana-defi")), "solana", "pre-rename rows");
  assert.equal(stakingFamily(h("auto", "Jito MEV Rewards: Helius", "solana-defi")), "solana", "pre-rename rows");
  for (const p of ["Axie Staking", "Jupiter DAO", "Kamino Staking", "SKR Staking: Solana Mobile", "Wormhole Staking", "Navi", "Hyperliquid", "Stader"]) {
    assert.equal(stakingFamily(h("auto", p, "x")), null, p);
  }
  assert.equal(stakingFamily(h("auto_cosmos", null, "cosmoshub")), null, "a plain Cosmos balance isn't a position");
});

test("a group is Staking only when every position is native staking", () => {
  assert.equal(groupFamily([h("auto", "Sui native staking", "sui"), h("auto", "Sui native staking", "sui")]), "sui");
  assert.equal(groupFamily([h("auto", "Sui native staking", "sui"), h("auto", "Navi", "sui")]), null);
  assert.equal(groupFamily([]), null);
});

test("links: Keplr only when the stored link is a Keplr page; Solana is managed in the wallet", () => {
  assert.equal(stakingLinks("cosmos", "https://wallet.keplr.app/chains/cosmos-hub").manage?.url, "https://wallet.keplr.app/chains/cosmos-hub");
  assert.equal(stakingLinks("cosmos", "https://www.mintscan.io/archway/validators/x").manage, null);
  assert.equal(stakingLinks("sei", null).manage?.url, "https://dashboard.sei.io/stake");
  assert.equal(stakingLinks("solana", null).manage, null);
  assert.match(stakingLinks("solana", null).guide.url, /phantom/);
});

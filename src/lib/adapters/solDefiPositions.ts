import "server-only";
import type { AdapterHolding } from "./types";
import { protocolScope, type KeepScope } from "../carryForward";
import { fetchJupiterPositions } from "./jupiterPositions";
import { fetchKaminoPositions } from "./kaminoPositions";
import { fetchWormholeStaking } from "./wormholeStaking";
import { fetchMeteoraPositions } from "./meteoraPositions";
import { fetchParclPositions } from "./parclPositions";
import { fetchJupiterDaoStaking } from "./jupiterDaoStaking";
import { fetchSolanaStaking } from "./solanaStaking";
import { fetchSkrStaking } from "./skrStaking";
import { fetchJitoMevRewards } from "./jitoMevRewards";
import { fetchLuloPositions } from "./lulo";
import { fetchTokenInfo } from "./jupiter";

export interface SolPositionsResult {
  holdings: AdapterHolding[];
  warnings: string[];
  keep?: KeepScope[];
}

// Every SOL DeFi position source beyond plain token balances — shared by
// both a saved wallet's real sync (wallets/actions.ts) and the ad-hoc
// address lookup (lib/lookup.ts) so the two don't drift. Each source is
// independent: one throwing becomes a warning, never discards another
// source's correctly-fetched data (same rule as evm.ts's chains+
// Hyperliquid split). Add a new protocol here as its own entry once it
// has a verified adapter — this is the only place a new SOL DeFi source
// needs wiring in.
// `keep`: the rows a source owns (by the protocol names it writes), kept
// from the last sync when it fails — see carryForward.ts.
const SOURCES: { name: string; keep: KeepScope; fetch: (address: string) => Promise<SolPositionsResult> }[] = [
  {
    name: "jupiter positions",
    // "Jupiter <product>" (jupiterPositions.ts), but not Jupiter DAO below.
    keep: { label: "jupiter positions", owns: (h) => !!h.protocol?.startsWith("Jupiter ") && h.protocol !== "Jupiter DAO" },
    fetch: fetchJupiterPositions,
  },
  { name: "kamino", keep: protocolScope("kamino", "Kamino"), fetch: fetchKaminoPositions },
  {
    name: "wormhole",
    keep: protocolScope("wormhole", "Wormhole Staking"),
    fetch: (address) => fetchWormholeStaking(address).then((holdings) => ({ holdings, warnings: [] })),
  },
  { name: "meteora", keep: protocolScope("meteora", "Meteora"), fetch: fetchMeteoraPositions },
  { name: "parcl", keep: protocolScope("parcl", "Parcl"), fetch: fetchParclPositions },
  {
    name: "jupiter dao",
    keep: protocolScope("jupiter dao", "Jupiter DAO"),
    fetch: (address) => fetchJupiterDaoStaking(address).then((holdings) => ({ holdings, warnings: [] })),
  },
  {
    name: "solana staking",
    keep: {
      label: "solana staking",
      owns: (h) => (h.protocol === "Solana native staking" && h.protocol_section === "Staked") || !!h.protocol?.startsWith("Solana Staking: "),
    },
    fetch: (address) => fetchSolanaStaking(address).then((holdings) => ({ holdings, warnings: [] })),
  },
  {
    name: "skr staking",
    keep: protocolScope("skr staking", "SKR Staking"),
    fetch: (address) => fetchSkrStaking(address).then((holdings) => ({ holdings, warnings: [] })),
  },
  {
    name: "jito mev rewards",
    keep: {
      label: "jito mev rewards",
      owns: (h) => !!h.display_label?.startsWith("Jito MEV rewards") || !!h.protocol?.startsWith("Jito MEV Rewards: "),
    },
    fetch: fetchJitoMevRewards,
  },
  {
    name: "lulo",
    keep: protocolScope("lulo", "Lulo"),
    fetch: (address) => fetchLuloPositions(address).then((holdings) => ({ holdings, warnings: [] })),
  },
];

/**
 * Every real-mint DeFi holding (Wormhole's W stake, Parcl's USDC margin,
 * Jupiter DAO's locked JUP, Kamino's underlying deposits, ...) has a known
 * on-chain mint but none of these adapters set icon_url — unlike
 * fetchJupiterHoldings (plain token balances), which gets an icon for free
 * from the same tokens/v2/search response it already uses for pricing.
 * Backfilled here, once, for every source at once, rather than patching
 * each adapter individually — real gap reported live: every DeFi protocol
 * group on the wallet detail page showed a generic letter badge instead of
 * the token's real logo, even for tickers (W, JUP, KMNO, USDC) that already
 * render correctly in the plain-token section above. Best-effort: a lookup
 * failure here shouldn't fail the actual holdings fetch, icons are cosmetic.
 * Mutates in place rather than rebuilding the array — cheap, and every
 * caller already treats these as fresh objects, not shared/cached ones.
 * Synthetic contract-less tickers (Kamino's KAMINO-{MULTIPLY,LEVERAGE,...}
 * leveraged positions, KAMINO-LP) have no single underlying mint to resolve
 * and are left as-is — a static per-protocol icon is a separate, later fix.
 */
async function backfillDefiIcons(holdings: AdapterHolding[]): Promise<void> {
  const mints = [...new Set(holdings.filter((h) => h.contract && !h.icon_url).map((h) => h.contract!))];
  if (mints.length === 0) return;
  const tokenInfo = await fetchTokenInfo(mints).catch(() => new Map());
  for (const h of holdings) {
    if (h.contract && !h.icon_url) {
      const icon = tokenInfo.get(h.contract)?.icon;
      if (icon) h.icon_url = icon;
    }
  }
}

export async function fetchSolDefiPositions(address: string): Promise<SolPositionsResult> {
  const results = await Promise.all(
    SOURCES.map(({ name, keep, fetch }) =>
      fetch(address).catch((e: Error) => ({
        holdings: [] as AdapterHolding[],
        warnings: [`${name}: ${e.message}`],
        keep: [keep],
      })),
    ),
  );
  const holdings = results.flatMap((r) => r.holdings);
  await backfillDefiIcons(holdings);
  return {
    holdings,
    warnings: results.flatMap((r) => r.warnings),
    keep: results.flatMap((r) => r.keep ?? []),
  };
}

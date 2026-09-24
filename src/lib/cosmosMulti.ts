// Pure logic for pulling every Cosmos-chain token a cosmos1… address holds
// (adapters/cosmosMulti.ts does the network part) — see cosmosMulti.test.ts.
//
// One key, many chains: most Cosmos SDK chains use coin type 118, so the
// same account's address on Osmosis, Stride, Celestia, … is the cosmos1…
// address's 20 bytes re-encoded with that chain's bech32 prefix. Chains on a
// different coin type (Injective: 60) hold a different account entirely and
// are excluded — the user adds those as their own wallet.
//
// Chain + token metadata come from cosmos.directory (the Cosmos
// chain-registry, served as one JSON): each asset's symbol, decimals,
// CoinGecko id, logo and CoinGecko's USD price. A holding is priced ONLY by
// its own CoinGecko id — never by ticker — so a spam or look-alike token can
// never borrow a real token's price (same rule as EVM's per-holding
// usd_override; see valuation.ts and CLAUDE.md "Data correctness").

import "server-only";
import { bech32 } from "@scure/base";

export interface DirectoryAsset {
  denom: string;
  symbol: string;
  decimals: number | null;
  coingeckoId: string | null;
  usd: number | null;
  image: string | null;
}

export interface DirectoryChain {
  name: string; // cosmos.directory chain name, e.g. "osmosis" — used as holding.chain
  prettyName: string;
  prefix: string;
  restUrls: string[];
  /** cosmos.directory listed no healthy REST endpoint for this chain — its
   * chain-registry chain.json's own list is tried instead (withRegistryApis). */
  needsRegistryApis: boolean;
  assets: Map<string, DirectoryAsset>; // by denom
}

/** A Cosmos holding before insertion (sync_cosmos_holdings). */
export interface CosmosHolding {
  ticker: string;
  qty: number | null;
  usd_override: number | null;
  contract: string; // the denom — the token's real identity on that chain
  category: "token";
  chain: string;
  icon_url: string | null;
  coingecko_id: string | null;
  display_label: string | null;
}

type RawChain = {
  name?: string;
  pretty_name?: string;
  bech32_prefix?: string;
  slip44?: number;
  status?: string;
  network_type?: string;
  best_apis?: { rest?: { address?: string }[] };
  assets?: {
    denom?: string;
    symbol?: string;
    decimals?: number;
    coingecko_id?: string;
    prices?: { coingecko?: { usd?: number } };
    image?: string;
    logo_URIs?: { png?: string; svg?: string };
  }[];
};

/** Live mainnet chains whose accounts are derivable from a cosmos1 address
 * (coin type 118), each with REST endpoints to try in order: cosmos.directory's
 * own proxy first, then the chain's listed public endpoints. */
export function eligibleChains(raw: readonly RawChain[]): DirectoryChain[] {
  const out: DirectoryChain[] = [];
  for (const c of raw) {
    if (!c.name || !c.bech32_prefix || c.slip44 !== 118 || c.status !== "live" || c.network_type !== "mainnet") continue;
    const listed = (c.best_apis?.rest ?? []).map((r) => r.address?.replace(/\/+$/, "")).filter((u): u is string => !!u);
    const assets = new Map<string, DirectoryAsset>();
    for (const a of c.assets ?? []) {
      if (!a.denom || !a.symbol) continue;
      assets.set(a.denom, {
        denom: a.denom,
        symbol: a.symbol,
        decimals: typeof a.decimals === "number" ? a.decimals : null,
        coingeckoId: a.coingecko_id || null,
        usd: typeof a.prices?.coingecko?.usd === "number" ? a.prices.coingecko.usd : null,
        image: a.logo_URIs?.png ?? a.image ?? a.logo_URIs?.svg ?? null,
      });
    }
    out.push({
      name: c.name,
      prettyName: c.pretty_name ?? c.name,
      prefix: c.bech32_prefix,
      restUrls: [`https://rest.cosmos.directory/${c.name}`, ...listed.slice(0, 2)],
      needsRegistryApis: listed.length === 0,
      assets,
    });
  }
  return out;
}

/** Adds a chain's chain-registry REST endpoints (chain.json `apis.rest`) after
 * cosmos.directory's proxy, for chains the directory lists none for (e.g.
 * Neutron — its proxy answered 502, the registry lists six endpoints). */
export function withRegistryApis(chain: DirectoryChain, chainJson: { apis?: { rest?: { address?: string }[] } } | null): DirectoryChain {
  const extra = (chainJson?.apis?.rest ?? [])
    .map((r) => r.address?.replace(/\/+$/, ""))
    .filter((u): u is string => !!u && !chain.restUrls.includes(u))
    .slice(0, 3);
  return { ...chain, restUrls: [...chain.restUrls, ...extra], needsRegistryApis: false };
}

/** The same account on another coin-type-118 chain. Throws on a non-cosmos1 input. */
export function deriveAddress(cosmosAddress: string, prefix: string): string {
  const { prefix: from, words } = bech32.decode(cosmosAddress.trim() as `${string}1${string}`);
  if (from !== "cosmos") throw new Error(`Not a cosmos1… address (prefix "${from}")`);
  return bech32.encode(prefix, words);
}

/** Exact base-units → token amount, without Number overflow on 18-decimal denoms. */
export function toTokenAmount(amount: string, decimals: number): number {
  const n = BigInt(amount);
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = n / scale;
  const frac = n % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

/**
 * One chain's bank balances → holdings. Known tokens get their symbol, logo
 * and — if they have a CoinGecko id and a price — a usd_override. Tokens the
 * registry doesn't know are still listed (never hidden), labeled by denom,
 * with qty unknown (null): without decimals, the raw base-unit amount would
 * be a misleading number, not an amount.
 */
export function holdingsFromBalances(chain: DirectoryChain, balances: readonly { denom: string; amount: string }[]): CosmosHolding[] {
  const out: CosmosHolding[] = [];
  for (const b of balances) {
    if (!/^\d+$/.test(b.amount) || BigInt(b.amount) === BigInt(0)) continue;
    const asset = chain.assets.get(b.denom);
    if (asset && asset.decimals !== null) {
      const qty = toTokenAmount(b.amount, asset.decimals);
      out.push({
        ticker: asset.symbol,
        qty,
        usd_override: asset.coingeckoId && asset.usd !== null ? qty * asset.usd : null,
        contract: b.denom,
        category: "token",
        chain: chain.name,
        icon_url: asset.image,
        coingecko_id: asset.coingeckoId,
        display_label: null,
      });
    } else {
      const short = b.denom.length > 20 ? `${b.denom.slice(0, 14)}…${b.denom.slice(-4)}` : b.denom;
      out.push({
        ticker: short,
        qty: null,
        usd_override: null,
        contract: b.denom,
        category: "token",
        chain: chain.name,
        icon_url: null,
        coingecko_id: null,
        display_label: `Unrecognized token on ${chain.prettyName} (${short})`,
      });
    }
  }
  return out;
}

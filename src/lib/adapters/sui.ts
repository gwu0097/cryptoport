import "server-only";
import { protocolScope, type KeepScope } from "../carryForward";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";
import { stakesToHoldings, normalizeSuiCoinType, estimateStakeReward, type SuiStakeGroup } from "../suiStakes";
import { fetchNaviHoldings } from "./naviLending";

// Sui's GraphQL API (Mysten's public endpoint). Sui's public fullnodes
// dropped JSON-RPC ("deprecated ... migrate to gRPC or GraphQL"), PublicNode
// went down, and the third-party JSON-RPC endpoints that still answer
// (Suiet, BlockPI) returned incomplete balances from stale indexes — which
// would be saved as the wallet's holdings (2026-09-25). GraphQL returned the
// complete set. A failed query fails the sync (previous holdings kept).
const GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql";
const NATIVE_COIN_TYPE = "0x2::sui::SUI";

const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

export function isSuiAddress(value: string): boolean {
  return SUI_ADDRESS_RE.test(value);
}

interface CoinBalance {
  coinType: string;
  totalBalance: string; // base units, decimal string
}

interface CoinMetadata {
  decimals: number;
  name: string;
  symbol: string;
  iconUrl: string | null;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetchWithRetry(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Sui GraphQL failed: HTTP ${res.status}`);
  const body: { data?: T; errors?: { message: string }[] } = await res.json();
  if (body.errors?.length) throw new Error(`Sui GraphQL error: ${body.errors[0].message}`);
  if (!body.data) throw new Error("Sui GraphQL returned no data");
  return body.data;
}

interface Page<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Every page of a connection (50 per page, GraphQL's max), capped. */
async function allPages<N>(fetchPage: (after: string | null) => Promise<Page<N>>, maxPages = 20): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: Page<N> = await fetchPage(after);
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
  throw new Error("Sui GraphQL: too many pages");
}

export async function fetchBalances(address: string): Promise<CoinBalance[]> {
  const nodes = await allPages(async (after) => {
    const d = await gql<{ address: { balances: Page<{ coinType: { repr: string }; totalBalance: string }> } | null }>(
      `query($a: SuiAddress!, $after: String) { address(address: $a) { balances(first: 50, after: $after) { nodes { coinType { repr } totalBalance } pageInfo { hasNextPage endCursor } } } }`,
      { a: address, after },
    );
    return d.address?.balances ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  });
  return nodes.map((n) => ({ coinType: normalizeSuiCoinType(n.coinType.repr), totalBalance: n.totalBalance }));
}

// The public endpoint allows 21 "backing store" lookups per request, and a
// coinMetadata with decimals/symbol/iconUrl costs about two (measured
// 2026-09-25: 8 per query passes, 10 fails) — so batches of 8.
const LOOKUPS_PER_QUERY = 8;

/** Metadata for many coin types, LOOKUPS_PER_QUERY per query (one aliased
 * field each). */
export async function fetchCoinMetadata(coinTypes: string[]): Promise<Map<string, CoinMetadata | null>> {
  const out = new Map<string, CoinMetadata | null>();
  for (let i = 0; i < coinTypes.length; i += LOOKUPS_PER_QUERY) {
    const batch = coinTypes.slice(i, i + LOOKUPS_PER_QUERY);
    const vars = Object.fromEntries(batch.map((t, j) => [`t${j}`, t]));
    const query = `query(${batch.map((_, j) => `$t${j}: String!`).join(", ")}) { ${batch
      .map((_, j) => `m${j}: coinMetadata(coinType: $t${j}) { decimals symbol iconUrl }`)
      .join(" ")} }`;
    const d = await gql<Record<string, CoinMetadata | null>>(query, vars);
    batch.forEach((t, j) => out.set(t, d[`m${j}`] ?? null));
  }
  return out;
}

/** A real HTTPS URL, or null — a coin's metadata can carry a
 * `data:image/...;base64,...` icon inline (seen live: one coin's metadata
 * carried a >100KB embedded JPEG this way) instead of a hosted URL. Storing
 * that verbatim would bloat this holding's row and every page that renders
 * it for no benefit over the existing letter-avatar fallback, so only a
 * genuine link is kept. */
function realIconUrl(iconUrl: string | null): string | null {
  return iconUrl && iconUrl.startsWith("http") ? iconUrl : null;
}

/**
 * Every coin type the address holds a nonzero balance of — not just native
 * SUI. Reported directly, with real data: a wallet holding SUI, USDC, and a
 * meme token only showed SUI, because the original version of this adapter
 * only ever read the native SUI balance. The address's `balances`
 * connection (Sui GraphQL) enumerates every coin type Sui tracks for it;
 * `coinMetadata` resolves each type's symbol/decimals/icon.
 *
 * Non-native coins are priced the same way multicallEvm.ts prices EVM
 * tokens: a real per-*contract* CoinGecko lookup (fetchTokenPrices against
 * the "sui" asset platform, live-verified against this wallet's real coin
 * types — resolved USDC/AUSD/S/BLUE/SCB/TARDI correctly, including "S",
 * which is priced at its own ~$0.0001 rather than colliding with an
 * unrelated asset that happens to share that short ticker). This is
 * deliberately NOT a self-reported-symbol stablecoin pin (the earlier draft
 * of this fix trusted `meta.symbol === "USDC"`, which is exactly the
 * spoofed-token shape CLAUDE.md's Data Correctness rule warns about — a
 * coin's publisher controls its own symbol string, not CoinGecko).
 *
 * KNOWN GAP, same one valuation.ts already documents for Solana SPL
 * balances: a coin type CoinGecko can't price by contract (seen live: a
 * few genuinely obscure ones — SuiReward, GMB, a coin literally named
 * "TOKEN") falls through to the shared ticker-keyed `prices` table, same
 * collision risk as any other unpriced-by-contract token. Not closed here
 * for the same reason it isn't closed for Solana: excluding a holding from
 * that fallback entirely is a valuation.ts design change, not a one-line
 * patch. In practice this only affects long-tail/illiquid coins with no
 * CoinGecko contract listing at all.
 *
 * Native SUI itself is unchanged — still priced via the existing
 * ticker-keyed `prices` table (SUI is CoinGecko's platform's own native
 * asset, not a candidate for a ticker collision the way an arbitrary
 * third-party coin type is).
 */
export async function fetchSuiHoldings(address: string): Promise<AdapterHolding[]> {
  const balances = await fetchBalances(address);
  const held = balances.filter((b) => BigInt(b.totalBalance) > BigInt(0));
  if (held.length === 0) return [];

  // A metadata query failing never drops the wallet's real, verified
  // balances — same "one source's failure never discards another's
  // correctly-fetched data" rule this app applies everywhere else; a coin
  // with no metadata is skipped below (no decimals to scale by).
  const metadataByType = await fetchCoinMetadata(held.map((b) => b.coinType)).catch(() => new Map<string, CoinMetadata | null>());


  const holdings: AdapterHolding[] = [];
  for (const b of held) {
    const meta = metadataByType.get(b.coinType);
    // No metadata resolved at all means no decimals to scale the raw base-
    // unit balance by — showing a real quantity with a made-up decimal
    // count would be a wrong number, not a missing one, so this coin type
    // is skipped rather than guessed. Rare in practice (only seen for a
    // genuinely broken/unregistered coin type).
    if (!meta) continue;

    const qty = Number(b.totalBalance) / 10 ** meta.decimals;
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const isNative = b.coinType === NATIVE_COIN_TYPE;
    holdings.push({
      ticker: meta.symbol.toUpperCase(),
      qty,
      usd_override: null, // priced by its asset key after the sync (docs/pricing/PLAN.md)
      contract: isNative ? null : b.coinType,
      category: "token",
      chain: "sui",
      icon_url: realIconUrl(meta.iconUrl),
    });
  }

  // SUI's own icon still comes from CoinGecko (matching the pre-existing
  // behavior) rather than Sui's own metadata endpoint, which returned an
  // empty iconUrl for the native coin in live testing.
  const suiHolding = holdings.find((h) => h.contract === null);
  if (suiHolding && !suiHolding.icon_url) {
    const images = await fetchTokenImages(["sui"]).catch(() => new Map<string, string>());
    suiHolding.icon_url = images.get("sui") ?? null;
  }

  return holdings;
}

/**
 * A Sui wallet: every coin balance (fetchSuiHoldings), its Navi lending
 * positions (naviLending.ts — deposits live inside the protocol, not as
 * coins), plus its native staking — SUI delegated to validators (the
 * wallet's StakedSui objects), which never shows up as a coin balance
 * (reported 2026-09-24: a Ledger wallet's 300 SUI staked with ZKV + ~19 SUI
 * rewards, ~$320, was missing). Validator names and rates come from the
 * epoch's active validator set. A staking lookup that fails is a
 * warning, never a reason to drop the wallet's real coin balances.
 */
export async function fetchSuiWallet(address: string): Promise<{ holdings: AdapterHolding[]; warnings: string[]; keep: KeepScope[] }> {
  // Coins, native stakes and Navi lending in parallel; only the coin scan is
  // required — the other two degrade to a warning.
  const [holdings, stakes, navi] = await Promise.all([
    fetchSuiHoldings(address),
    fetchSuiStakeHoldings(address).then(
      (h) => ({ holdings: h, warnings: [] as string[], keep: [] as KeepScope[] }),
      (e: Error) => ({ holdings: [], warnings: [`Sui staking positions couldn't be loaded: ${e.message}`], keep: [protocolScope("sui staking", "Sui native staking")] }),
    ),
    fetchNaviHoldings(address).then(
      (r) => ({ ...r, keep: [] as KeepScope[] }),
      (e: Error) => ({ holdings: [], warnings: [`Navi lending positions couldn't be loaded: ${e.message}`], keep: [protocolScope("navi", "Navi")] }),
    ),
  ]);
  const suiIcon = holdings.find((h) => h.chain === "sui" && h.contract === null)?.icon_url ?? null;
  return {
    holdings: [...holdings, ...stakes.holdings.map((h) => ({ ...h, icon_url: h.icon_url ?? suiIcon })), ...navi.holdings],
    warnings: [...stakes.warnings, ...navi.warnings],
    keep: [...stakes.keep, ...navi.keep],
  };
}

interface StakeObject {
  pool_id: string;
  stake_activation_epoch: string;
  principal: string;
}

interface PoolInfo {
  validatorAddress: string;
  name: string;
  sui_balance: string;
  pool_token_balance: string;
  exchangeRatesId: string;
}

/** Native stakes: the wallet's StakedSui objects, each valued with its
 * validator pool's exchange rates (suiStakes.ts's estimateStakeReward) —
 * GraphQL has no ready-made "estimated reward" the way suix_getStakes did.
 * A stake whose rate can't be read keeps its principal, reward unknown. */
export async function fetchSuiStakeHoldings(address: string): Promise<AdapterHolding[]> {
  const stakes = await allPages(async (after) => {
    const d = await gql<{ address: { objects: Page<{ contents: { json: StakeObject } }> } | null }>(
      `query($a: SuiAddress!, $after: String) { address(address: $a) { objects(filter: { type: "0x3::staking_pool::StakedSui" }, first: 50, after: $after) { nodes { contents { json } } pageInfo { hasNextPage endCursor } } } }`,
      { a: address, after },
    );
    return d.address?.objects ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  });
  if (stakes.length === 0) return [];

  // The active validator set (~130, 50 per page): pool id -> validator.
  let epoch = 0;
  const validators = await allPages(async (after) => {
    const d = await gql<{ epoch: { epochId: number; validatorSet: { activeValidators: Page<{ contents: { json: ValidatorJson } }> } } }>(
      `query($after: String) { epoch { epochId validatorSet { activeValidators(first: 50, after: $after) { nodes { contents { json } } pageInfo { hasNextPage endCursor } } } } }`,
      { after },
    );
    epoch = Number(d.epoch.epochId);
    return d.epoch.validatorSet.activeValidators;
  });
  const pools = new Map<string, PoolInfo>(
    validators.map(({ contents: { json: v } }) => [
      v.staking_pool.id,
      {
        validatorAddress: v.metadata.sui_address,
        name: v.metadata.name,
        sui_balance: v.staking_pool.sui_balance,
        pool_token_balance: v.staking_pool.pool_token_balance,
        exchangeRatesId: v.staking_pool.exchange_rates.id,
      },
    ]),
  );

  // Each active stake's activation-epoch exchange rate, one aliased query.
  const active = stakes.map((s) => s.contents.json).filter((s) => pools.has(s.pool_id) && Number(s.stake_activation_epoch) <= epoch);
  const rates = new Map<number, { sui_amount: string; pool_token_amount: string } | null>();
  for (let i = 0; i < active.length; i += LOOKUPS_PER_QUERY) {
    const batch = active.slice(i, i + LOOKUPS_PER_QUERY);
    const query = `query { ${batch
      .map((s, j) => {
        const key = Buffer.alloc(8);
        key.writeBigUInt64LE(BigInt(s.stake_activation_epoch));
        return `r${j}: address(address: "${pools.get(s.pool_id)!.exchangeRatesId}") { dynamicField(name: { type: "u64", bcs: "${key.toString("base64")}" }) { value { ... on MoveValue { json } } } }`;
      })
      .join(" ")} }`;
    const d = await gql<Record<string, { dynamicField: { value: { json: { sui_amount: string; pool_token_amount: string } } } | null } | null>>(query).catch(() => null);
    batch.forEach((_, j) => rates.set(i + j, d?.[`r${j}`]?.dynamicField?.value?.json ?? null));
  }

  const groups = new Map<string, SuiStakeGroup>();
  const names = new Map<string, string>();
  for (const { contents: { json: s } } of stakes) {
    const pool = pools.get(s.pool_id);
    const key = pool?.validatorAddress ?? s.pool_id; // a stake with a validator no longer active
    if (pool) names.set(key, pool.name);
    const pending = Number(s.stake_activation_epoch) > epoch;
    const idx = active.indexOf(s);
    const rate = idx >= 0 ? rates.get(idx) : null;
    const reward = pool && rate ? estimateStakeReward(BigInt(s.principal), rate, pool) : null;
    const g = groups.get(key) ?? { validatorAddress: key, stakes: [] };
    g.stakes.push({ principal: s.principal, estimatedReward: reward === null ? undefined : reward.toString(), status: pending ? "Pending" : "Active" });
    groups.set(key, g);
  }
  return stakesToHoldings([...groups.values()], names, null);
}

interface ValidatorJson {
  metadata: { sui_address: string; name: string };
  staking_pool: { id: string; sui_balance: string; pool_token_balance: string; exchange_rates: { id: string } };
}

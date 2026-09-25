import "server-only";
import { seiAccountIsLinked } from "./seiStaking";
import { Resolver } from "node:dns/promises";
import { serviceDb } from "../supabase";
import { chainScope, type KeepScope } from "../carryForward";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import { fetchMarketsByIds } from "./coingecko";
import { cachedCoinPrices } from "./coinCache";
import {
  eligibleChains,
  deriveAddress,
  holdingsFromBalances,
  withRegistryApis,
  withKeplrCurrencies,
  withPrices,
  keplrRegistryFile,
  keplrDashboardUrl,
  withoutDirectoryProxy,
  downChains,
  stakingHoldings,
  lockUnlinkedSei,
  type CosmosHolding,
  type CosmosStakingData,
  type DirectoryChain,
} from "../cosmosMulti";

// Network half of the Cosmos multi-chain wallet (pure logic + the why:
// ../cosmosMulti.ts). A cosmos1… wallet's sync scans every live coin-type-118
// Cosmos chain in cosmos.directory's registry (~159) for the same account,
// and stores every token as an `auto_cosmos` holding (sync_cosmos_holdings):
// priced only by its own CoinGecko id, re-priced by "Refresh prices"
// (refreshCosmosHoldingPrices below), never by ticker.

const DIRECTORY_URL = "https://chains.cosmos.directory/";
const STATUS_URL = "https://status.cosmos.directory/";
const REGISTRY_RAW = "https://raw.githubusercontent.com/cosmos/chain-registry/master";
const KEPLR_RAW = "https://raw.githubusercontent.com/chainapsis/keplr-chain-registry/main/cosmos";
const CONCURRENCY = 12;
const PER_REQUEST_TIMEOUT_MS = 6_000;
// The sync runs in after() under the route's 300s maxDuration; stop starting
// new fallback attempts well before that. A chain not reached in time is
// reported as unreachable, never silently treated as empty.
const SCAN_DEADLINE_MS = 150_000;

export async function fetchCosmosMultiHoldings(cosmosAddress: string): Promise<{ holdings: CosmosHolding[]; warnings: string[]; keep: KeepScope[] }> {
  // cosmos.directory's health check, alongside its chain list; best-effort
  // (null = unknown: every chain is scanned and warned about as before).
  const statusPromise = fetch(STATUS_URL, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => (b ? downChains(b) : null))
    .catch(() => null);
  const res = await fetchWithRetry(DIRECTORY_URL);
  if (!res.ok) throw new Error(`cosmos.directory chain list failed: HTTP ${res.status}`);
  const listed = eligibleChains(((await res.json()) as { chains: Parameters<typeof eligibleChains>[0] }).chains);
  if (listed.length === 0) throw new Error("cosmos.directory returned no eligible chains");
  // Chains the directory lists no healthy endpoint for: read their own
  // chain-registry chain.json for its REST list (small GitHub files, in parallel).
  const chains = await mapWithConcurrency(listed, CONCURRENCY, async (chain) => {
    if (!chain.needsRegistryApis) return chain;
    try {
      const r = await fetch(`${REGISTRY_RAW}/${chain.name}/chain.json`, { cache: "no-store", signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
      return withRegistryApis(chain, r.ok ? ((await r.json()) as Parameters<typeof withRegistryApis>[1]) : null);
    } catch {
      return withRegistryApis(chain, null);
    }
  });

  const down = await statusPromise;
  const scanList = down ? chains.map((c) => (down.has(c.name) ? withoutDirectoryProxy(c) : c)) : chains;

  const started = Date.now();
  const dnsCache = new Map<string, Promise<boolean>>();
  const scanned = await mapWithConcurrency(scanList, CONCURRENCY, (chain) => scanChain(chain, cosmosAddress, started, dnsCache));

  // Tokens the Cosmos chain registry can't identify (no entry, or no
  // CoinGecko id — e.g. stINJ, milkTIA, dATOM): fill from Keplr's registry
  // by exact denom, only for chains that actually hold such tokens.
  const results = await mapWithConcurrency(scanned, CONCURRENCY, async (r) => {
    const stakingDenom = r.staking && (r.staking.delegations.length || r.staking.unbonding.length) ? r.chain.stakingDenom : null;
    const gap = [...r.balances.map((b) => b.denom), ...(stakingDenom ? [stakingDenom] : [])].some((d) => !r.chain.assets.get(d)?.coingeckoId);
    const file = keplrRegistryFile(r.chain.chainId);
    if (r.unreachable || !gap || !file) return r;
    try {
      const k = await fetch(`${KEPLR_RAW}/${file}`, { cache: "no-store", signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
      if (!k.ok) return r;
      const chain = withKeplrCurrencies(r.chain, (await k.json()) as Parameters<typeof withKeplrCurrencies>[1]);
      return { ...r, chain, holdings: rowsFor(chain, r.balances, r.staking, r.monikers) };
    } catch {
      return r;
    }
  });
  let holdings = results.flatMap((r) => r.holdings);
  const warnings: string[] = [];
  // Sei is EVM-only since SIP-3: an account never linked to its 0x address
  // can't move its SEI, so those rows are listed but not counted.
  if (holdings.some((h) => h.chain === "sei")) {
    const linked = await seiAccountIsLinked(deriveAddress(cosmosAddress, "sei"));
    if (linked === false) holdings = lockUnlinkedSei(holdings);
    if (linked === null) warnings.push("Couldn't check whether the Sei account is linked to an EVM address; Sei rows counted as usual");
  }
  holdings = await withKeplrManageUrls(holdings);
  await saveChainIcons(results.filter((r) => r.holdings.length > 0).map((r) => r.chain));
  // Dead chains (down per cosmos.directory and unreachable on their own
  // endpoints too) aren't warned about — 66 of them on every sync was noise
  // (2026-09-25); their rows, if any, are still kept (keep below).
  const unreachable = results.filter((r) => r.unreachable && !down?.has(r.chain.name)).map((r) => r.chain.prettyName);
  // Rows these failures leave unanswered are kept from the last sync
  // (carryForward.ts): every row of an unreachable chain, and the staking
  // rows of a chain whose staking couldn't be read.
  const keep: KeepScope[] = [
    ...results.filter((r) => r.unreachable).map((r) => chainScope(r.chain.prettyName, r.chain.name)),
    ...results
      .filter((r) => !r.unreachable && r.staking === null)
      .map((r): KeepScope => ({ label: `${r.chain.prettyName} staking`, owns: (h) => h.chain === r.chain.name && h.category === "defi" })),
  ];

  // Identified tokens cosmos.directory had no price for: CoinGecko by id, in
  // one batched call (shared 60s cache) — only when there are any.
  const needPrice = [...new Set(holdings.filter((h) => h.coingecko_id && h.usd_override === null && h.qty !== null).map((h) => h.coingecko_id!))];
  if (needPrice.length > 0) {
    try {
      // coin_cache: another sync's price from the last few minutes is reused.
      holdings = withPrices(holdings, await cachedCoinPrices(needPrice));
    } catch (e) {
      warnings.push(`CoinGecko prices unavailable for ${needPrice.length} token(s): ${(e as Error).message}`);
    }
  }
  if (unreachable.length > 0) {
    warnings.push(
      `${unreachable.length} of ${chains.length} Cosmos chains couldn't be reached (their tokens may be missing): ${unreachable.slice(0, 12).join(", ")}${unreachable.length > 12 ? ", …" : ""}`,
    );
  }
  const noStaking = results.filter((r) => !r.unreachable && r.staking === null).map((r) => r.chain.prettyName);
  if (noStaking.length > 0) warnings.push(`Staking couldn't be read on ${noStaking.length} chain(s): ${noStaking.slice(0, 8).join(", ")}${noStaking.length > 8 ? ", …" : ""}`);
  // Unrecognized tokens aren't reported as a warning: their rows are listed
  // and labeled "Unrecognized token on <chain>" — not a sync problem.
  return { holdings, warnings, keep };
}

type Balance = { denom: string; amount: string };

/** Staking rows link to where you stake/unstake — the chain's Keplr
 * Dashboard page — when Keplr has one (checked here, once per staked chain
 * per sync: the page's title names the chain; an unsupported chain's page
 * has none). Otherwise they keep the validator's Mintscan page. Best-effort:
 * a failed check just keeps Mintscan. */
async function withKeplrManageUrls(holdings: CosmosHolding[]): Promise<CosmosHolding[]> {
  const staked = [...new Set(holdings.filter((h) => h.category === "defi").map((h) => h.chain))];
  if (staked.length === 0) return holdings;
  const ok = new Set<string>();
  await mapWithConcurrency(staked, 6, async (name) => {
    try {
      const r = await fetch(keplrDashboardUrl(name), { cache: "no-store", signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
      if (r.ok && /\| Keplr Dashboard<\/title>/.test(await r.text())) ok.add(name);
    } catch {
      // keep Mintscan
    }
  });
  return holdings.map((h) => (h.category === "defi" && ok.has(h.chain) ? { ...h, protocol_url: keplrDashboardUrl(h.chain) } : h));
}

/** Each chain the wallet holds tokens on gets a chain_icons row (its
 * chain-registry logo) so its group shows an icon — only rows that don't
 * exist yet are added (a chain's existing icon, e.g. Cosmos Hub's CoinGecko
 * one, is left alone). Cosmetic: a failure never fails the sync. */
async function saveChainIcons(chains: readonly DirectoryChain[]): Promise<void> {
  const rows = chains.filter((c) => c.image).map((c) => ({ chain_id: c.name, image_url: c.image! }));
  if (rows.length === 0) return;
  const { error } = await serviceDb().from("chain_icons").upsert(rows, { onConflict: "chain_id", ignoreDuplicates: true });
  if (error) console.warn(`[cosmos] chain_icons upsert failed: ${error.message}`);
}

// Many registry endpoints point at domains that no longer exist. fetch()
// resolves hostnames with getaddrinfo on libuv's small thread pool (4
// threads), and a lookup for a dead domain can hang for many seconds — even
// after its request is aborted — so ~60 of them starved every other lookup
// in the process (measured 2026-09-24: a plain lookup of
// raw.githubusercontent.com took 24.6s mid-scan, and every Keplr registry
// fetch timed out). Each host is checked first with c-ares (dns.Resolver:
// asynchronous, off that pool, with its own short timeout); a host that
// doesn't resolve is skipped, so only live hosts ever reach getaddrinfo.
const resolver = new Resolver({ timeout: 2_000, tries: 1 });

function hostResolves(url: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  const host = new URL(url).hostname;
  let p = cache.get(host);
  if (!p) {
    p = resolver
      .resolve4(host)
      .then((a) => a.length > 0)
      .catch(() => resolver.resolve6(host).then((a) => a.length > 0, () => false));
    cache.set(host, p);
  }
  return p;
}

type Scanned = {
  chain: DirectoryChain;
  balances: Balance[];
  staking: CosmosStakingData | null; // null = couldn't be read on this chain
  monikers: Map<string, string>;
  holdings: CosmosHolding[];
  unreachable: boolean;
};

const rowsFor = (chain: DirectoryChain, balances: Balance[], staking: CosmosStakingData | null, monikers: Map<string, string>) => [
  ...holdingsFromBalances(chain, balances),
  ...(staking ? stakingHoldings(chain, staking, monikers) : []),
];

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

/** Delegations + unbonding for every reachable chain (unbonding even with no
 * delegation left — exactly the state right after unstaking everything);
 * rewards only where there are delegations. Same endpoint as the balances. */
async function readStaking(base: string, address: string): Promise<{ staking: CosmosStakingData; monikers: Map<string, string> }> {
  const [d, u] = await Promise.all([
    getJson<{ delegation_responses?: { delegation: { validator_address: string }; balance: { denom: string; amount: string } }[] }>(
      `${base}/cosmos/staking/v1beta1/delegations/${address}`,
    ),
    getJson<{ unbonding_responses?: { validator_address: string; entries: { balance: string; completion_time: string }[] }[] }>(
      `${base}/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`,
    ),
  ]);
  const delegations = (d.delegation_responses ?? []).map((x) => ({ validator: x.delegation.validator_address, amount: x.balance.amount }));
  const unbonding = (u.unbonding_responses ?? []).flatMap((x) =>
    x.entries.map((e) => ({ validator: x.validator_address, amount: e.balance, completionTime: e.completion_time })),
  );
  let rewards: CosmosStakingData["rewards"] = [];
  if (delegations.length > 0) {
    const rw = await getJson<{ rewards?: { validator_address: string; reward: { denom: string; amount: string }[] }[] }>(
      `${base}/cosmos/distribution/v1beta1/delegators/${address}/rewards`,
    ).catch(() => null);
    // Only the staking denom's rewards (stakingHoldings prices in that denom).
    const denom = delegations.length ? d.delegation_responses![0].balance.denom : null;
    rewards = (rw?.rewards ?? []).map((x) => ({ validator: x.validator_address, amount: x.reward.find((c) => c.denom === denom)?.amount ?? "0" }));
  }
  const monikers = new Map<string, string>();
  const validators = [...new Set([...delegations, ...unbonding].map((x) => x.validator))];
  await Promise.all(
    validators.map(async (v) => {
      const info = await getJson<{ validator?: { description?: { moniker?: string } } }>(`${base}/cosmos/staking/v1beta1/validators/${v}`).catch(() => null);
      const m = info?.validator?.description?.moniker?.trim();
      if (m) monikers.set(v, m);
    }),
  );
  return { staking: { delegations, rewards, unbonding }, monikers };
}

async function scanChain(
  chain: DirectoryChain,
  cosmosAddress: string,
  started: number,
  dnsCache: Map<string, Promise<boolean>>,
): Promise<Scanned> {
  const address = deriveAddress(cosmosAddress, chain.prefix);
  for (const base of chain.restUrls) {
    if (Date.now() - started > SCAN_DEADLINE_MS) break;
    if (!(await hostResolves(base, dnsCache))) continue;
    try {
      const r = await fetch(`${base}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=1000`, {
        cache: "no-store",
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
      if (!r.ok) {
        await r.body?.cancel(); // release the connection instead of leaving the body unread
        continue;
      }
      const body = (await r.json()) as { balances?: Balance[] };
      if (!Array.isArray(body.balances)) continue;
      const balances = body.balances.filter((b) => /^\d+$/.test(b.amount) && !/^0+$/.test(b.amount));
      const { staking, monikers } = await readStakingAnywhere(chain, base, address, started, dnsCache);
      return { chain, balances, staking, monikers, holdings: rowsFor(chain, balances, staking, monikers), unreachable: false };
    } catch {
      // timeout / network error: try the chain's next endpoint
    }
  }
  return { chain, balances: [], staking: null, monikers: new Map(), holdings: [], unreachable: true };
}

/** Staking from the endpoint that answered for balances, else the chain's
 * other endpoints in turn — a one-off timeout on one server used to report
 * "Staking couldn't be read" (Union, 2026-09-25) though another answered.
 * staking null = no endpoint answered. */
async function readStakingAnywhere(
  chain: DirectoryChain,
  first: string,
  address: string,
  started: number,
  dnsCache: Map<string, Promise<boolean>>,
): Promise<{ staking: CosmosStakingData | null; monikers: Map<string, string> }> {
  for (const base of [first, ...chain.restUrls.filter((u) => u !== first)]) {
    if (Date.now() - started > SCAN_DEADLINE_MS) break;
    if (base !== first && !(await hostResolves(base, dnsCache))) continue;
    try {
      return await readStaking(base, address);
    } catch {
      // next endpoint
    }
  }
  return { staking: null, monikers: new Map() };
}

/**
 * "Refresh prices" for Cosmos holdings: re-prices every `auto_cosmos` row
 * that has a CoinGecko id from CoinGecko's /coins/markets by that id (one
 * batched call per 250 ids, via the shared 60s price cache) — the Cosmos
 * counterpart of refreshEvmHoldingPrices. A row whose id gets no price this
 * time is set to unpriced rather than keeping an old number with no caption.
 */
export async function refreshCosmosHoldingPrices(): Promise<{ ticker: string; ok: boolean; error?: string }[]> {
  const db = serviceDb();
  const { data, error } = await db
    .from("holdings")
    .select("id, wallet_id, ticker, qty, coingecko_id")
    .eq("source", "auto_cosmos")
    .not("coingecko_id", "is", null);
  if (error) throw new Error(`Failed to load Cosmos holdings: ${error.message}`);
  const rows = (data ?? []) as { id: string; wallet_id: string; ticker: string; qty: number | string | null; coingecko_id: string }[];
  if (rows.length === 0) return [];

  const markets = await fetchMarketsByIds([...new Set(rows.map((r) => r.coingecko_id))]);
  const priceById = new Map(markets.map((m) => [m.id, m.price]));
  const upserts = rows.map((r) => {
    const price = priceById.get(r.coingecko_id) ?? null;
    const qty = r.qty === null ? null : Number(r.qty);
    return { id: r.id, wallet_id: r.wallet_id, ticker: r.ticker, source: "auto_cosmos", usd_override: price !== null && qty !== null ? qty * price : null };
  });
  const { error: upsertError } = await db.from("holdings").upsert(upserts, { onConflict: "id" });
  if (upsertError) throw new Error(`Failed to save Cosmos holding prices: ${upsertError.message}`);
  return upserts.map((u) => ({ ticker: u.ticker, ok: u.usd_override !== null, ...(u.usd_override === null ? { error: "No CoinGecko price for this id." } : {}) }));
}

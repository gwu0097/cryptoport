import "server-only";
import { Resolver } from "node:dns/promises";
import { serviceDb } from "../supabase";
import { fetchWithRetry, mapWithConcurrency } from "./http";
import { fetchMarketsByIds } from "./coingecko";
import {
  eligibleChains,
  deriveAddress,
  holdingsFromBalances,
  withRegistryApis,
  withKeplrCurrencies,
  withPrices,
  keplrRegistryFile,
  type CosmosHolding,
  type DirectoryChain,
} from "../cosmosMulti";

// Network half of the Cosmos multi-chain wallet (pure logic + the why:
// ../cosmosMulti.ts). A cosmos1… wallet's sync scans every live coin-type-118
// Cosmos chain in cosmos.directory's registry (~159) for the same account,
// and stores every token as an `auto_cosmos` holding (sync_cosmos_holdings):
// priced only by its own CoinGecko id, re-priced by "Refresh prices"
// (refreshCosmosHoldingPrices below), never by ticker.

const DIRECTORY_URL = "https://chains.cosmos.directory/";
const REGISTRY_RAW = "https://raw.githubusercontent.com/cosmos/chain-registry/master";
const KEPLR_RAW = "https://raw.githubusercontent.com/chainapsis/keplr-chain-registry/main/cosmos";
const CONCURRENCY = 12;
const PER_REQUEST_TIMEOUT_MS = 6_000;
// The sync runs in after() under the route's 300s maxDuration; stop starting
// new fallback attempts well before that. A chain not reached in time is
// reported as unreachable, never silently treated as empty.
const SCAN_DEADLINE_MS = 150_000;

export async function fetchCosmosMultiHoldings(cosmosAddress: string): Promise<{ holdings: CosmosHolding[]; warnings: string[] }> {
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

  const started = Date.now();
  const dnsCache = new Map<string, Promise<boolean>>();
  const scanned = await mapWithConcurrency(chains, CONCURRENCY, (chain) => scanChain(chain, cosmosAddress, started, dnsCache));

  // Tokens the Cosmos chain registry can't identify (no entry, or no
  // CoinGecko id — e.g. stINJ, milkTIA, dATOM): fill from Keplr's registry
  // by exact denom, only for chains that actually hold such tokens.
  const results = await mapWithConcurrency(scanned, CONCURRENCY, async (r) => {
    const gap = r.balances.some((b) => !r.chain.assets.get(b.denom)?.coingeckoId);
    const file = keplrRegistryFile(r.chain.chainId);
    if (r.unreachable || !gap || !file) return r;
    try {
      const k = await fetch(`${KEPLR_RAW}/${file}`, { cache: "no-store", signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
      if (!k.ok) return r;
      const chain = withKeplrCurrencies(r.chain, (await k.json()) as Parameters<typeof withKeplrCurrencies>[1]);
      return { ...r, chain, holdings: holdingsFromBalances(chain, r.balances) };
    } catch {
      return r;
    }
  });
  let holdings = results.flatMap((r) => r.holdings);
  await saveChainIcons(results.filter((r) => r.holdings.length > 0).map((r) => r.chain));
  const unreachable = results.filter((r) => r.unreachable).map((r) => r.chain.prettyName);

  const warnings: string[] = [];
  // Identified tokens cosmos.directory had no price for: CoinGecko by id, in
  // one batched call (shared 60s cache) — only when there are any.
  const needPrice = [...new Set(holdings.filter((h) => h.coingecko_id && h.usd_override === null && h.qty !== null).map((h) => h.coingecko_id!))];
  if (needPrice.length > 0) {
    try {
      const markets = await fetchMarketsByIds(needPrice);
      holdings = withPrices(holdings, new Map(markets.map((m) => [m.id, m.price])));
    } catch (e) {
      warnings.push(`CoinGecko prices unavailable for ${needPrice.length} token(s): ${(e as Error).message}`);
    }
  }
  if (unreachable.length > 0) {
    warnings.push(
      `${unreachable.length} of ${chains.length} Cosmos chains couldn't be reached (their tokens may be missing): ${unreachable.slice(0, 12).join(", ")}${unreachable.length > 12 ? ", …" : ""}`,
    );
  }
  const unrecognized = holdings.filter((h) => h.coingecko_id === null && h.qty === null).length;
  if (unrecognized > 0) warnings.push(`${unrecognized} unrecognized token(s) listed without an amount or price`);
  return { holdings, warnings };
}

type Balance = { denom: string; amount: string };

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

async function scanChain(
  chain: DirectoryChain,
  cosmosAddress: string,
  started: number,
  dnsCache: Map<string, Promise<boolean>>,
): Promise<{ chain: DirectoryChain; balances: Balance[]; holdings: CosmosHolding[]; unreachable: boolean }> {
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
      return { chain, balances, holdings: holdingsFromBalances(chain, balances), unreachable: false };
    } catch {
      // timeout / network error: try the chain's next endpoint
    }
  }
  return { chain, balances: [], holdings: [], unreachable: true };
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

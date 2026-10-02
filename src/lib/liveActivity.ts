import "server-only";
import { serviceDb } from "./supabase";
import { readAssetPrices } from "./adapters/assetPrices";
import { identifyLegs } from "./watchActivityCheck";
import { broadcastActivity } from "./liveBroadcast";
import { type ActivityBase, type RawChange, type TxActivity } from "./watchActivity";
import { appendActivity } from "./txActivityStore";
import { sendWatchAlerts } from "./watchAlertSend";
import { accountKeys, rawTxChanges, worthSaving, type RawWebhookTx } from "./webhookTx";
import { alchemyChanges, type AlchemyDelivery } from "./alchemyWebhookTx";
import { loadAlchemyWebhooks, type AlchemyWebhooks } from "./alchemyWebhookSync";
import { assetStates } from "./watchDiff";
import type { WatchSnapshot } from "./watchSnapshot";
import { openingLegs } from "./entryLiquidity";
import { newBreaker } from "./dbBreaker";
import { fetchTokenInfo } from "./adapters/jupiter";
import { fetchTokenMarkets } from "./adapters/geckoTerminal";
import type { ActivityLeg } from "./watchActivity";
import { after } from "next/server";
import { countDeliveries, type DeliveryCounter } from "./deliveryCounter";
import { STOP_TRADES_PER_MIN, STOP_TX_PER_MIN, SUSPECT_PER_HOUR } from "./liveBudget";
import { checkSuspect, turnLiveOff } from "./liveBotGuard";

/** Deliveries and trades per live address, this instance (bot watch). */
const delivered: DeliveryCounter = new Map();
const deliveredMin: DeliveryCounter = new Map();
const tradedMin: DeliveryCounter = new Map();

/** Counts a delivery's transactions (and trades) per live address, after the
 * response: 60 trades or 600 transactions in a minute stop it at once; 2,000
 * transactions in an hour have its day checked (liveBotGuard.ts). */
function watchForBots(chain: "SOL" | "ETH", perAddress: ReadonlyMap<string, number>, tradesPer: ReadonlyMap<string, number>): void {
  const now = Date.now();
  for (const [address, n] of perAddress) {
    const hour = countDeliveries(delivered, address, now, n);
    const minute = countDeliveries(deliveredMin, address, now, n, 60_000);
    const trades = countDeliveries(tradedMin, address, now, tradesPer.get(address) ?? 0, 60_000);
    if (trades >= STOP_TRADES_PER_MIN) after(() => turnLiveOff(chain, address, `${trades} trades in a minute`, clearLiveCache));
    else if (minute >= STOP_TX_PER_MIN) after(() => turnLiveOff(chain, address, `${minute} transactions in a minute`, clearLiveCache));
    else if (hour >= SUSPECT_PER_HOUR) after(() => checkSuspect(chain, address, clearLiveCache));
  }
}

/** Whether a transaction's changes are a trade (a coin out and another in). */
const isTrade = (changes: readonly RawChange[]) => changes.some((c) => c.qty > 0) && changes.some((c) => c.qty < 0);

/** For the coins a delivery opens: liquidity then, and circulating supply
 * (the alert's market cap), by asset key — Solana from Jupiter (the call
 * the "opened" alert made anyway), EVM from GeckoTerminal (one call per
 * chain for every coin). A failure means none, never a guess. */
async function entryMarkets(opening: readonly ActivityLeg[]): Promise<Map<string, { liq: number | null; supply: number | null }>> {
  const out = new Map<string, { liq: number | null; supply: number | null }>();
  const sol = opening.filter((l) => l.sourceChain === "solana" && l.contract);
  if (sol.length > 0) {
    const info = await fetchTokenInfo(sol.map((l) => l.contract!)).catch((e: Error) => {
      console.error(`Entry liquidity (Jupiter): ${e.message}`);
      return new Map();
    });
    for (const l of sol) {
      const i = info.get(l.contract!);
      if (i) out.set(l.assetKey, { liq: typeof i.liquidity === "number" && i.liquidity > 0 ? i.liquidity : null, supply: typeof i.circSupply === "number" && i.circSupply > 0 ? i.circSupply : null });
    }
  }
  const evm = opening.filter((l) => l.sourceChain !== "solana" && l.contract);
  for (const chain of new Set(evm.map((l) => l.sourceChain))) {
    const mine = evm.filter((l) => l.sourceChain === chain);
    const markets = await fetchTokenMarkets(chain, mine.map((l) => l.contract!)).catch((e: Error) => {
      console.error(`Entry liquidity (GeckoTerminal ${chain}): ${e.message}`);
      return new Map();
    });
    for (const l of mine) {
      const m = markets.get(l.contract!.toLowerCase());
      if (m) out.set(l.assetKey, { liq: m.liquidityUsd, supply: m.marketCapUsd && m.priceUsd ? m.marketCapUsd / m.priceUsd : null });
    }
  }
  return out;
}

// Wallet Watch live activity (docs/wallet-watch/PLAN.md, phases 5 and 6):
// what a Helius "raw" webhook (Solana) or an Alchemy Address Activity
// webhook (Ethereum, Arbitrum, Robinhood Chain) delivers, saved as legs on
// the watched address's tx_activity — the same store Refresh activity
// writes, deduped by transaction, tagged "webhook". Spam (a token that only
// arrived) is dropped before any request; the cursor isn't moved, so a
// Refresh still reads the same history and counts anything the webhook missed.

/** Cached in the process for a minute: every delivery needs them. */
const CACHE_MS = 60_000;
const liveCache = new Map<"SOL" | "ETH", { at: number; addresses: Set<string> }>();
let webhookCache: { at: number; webhooks: AlchemyWebhooks } | null = null;

/** This instance's breaker for the live receivers (dbBreaker.ts). */
export const liveBreaker = newBreaker();

/** One read in flight per chain per instance: a burst of deliveries shares
 * it (2026-10-01: dozens a second each asked, during a Supabase outage). */
const liveInFlight = new Map<"SOL" | "ETH", Promise<Set<string>>>();

async function liveAddresses(chain: "SOL" | "ETH"): Promise<Set<string>> {
  const hit = liveCache.get(chain);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.addresses;
  const pending = liveInFlight.get(chain);
  if (pending) return pending;
  const read = (async () => {
    const { data, error } = await serviceDb().from("watched_addresses").select("address").eq("chain", chain).eq("live", true);
    if (error) {
      // Supabase refusing: the last list this instance had, if any.
      if (hit) return hit.addresses;
      throw new Error(`Failed to load live addresses: ${error.message}`);
    }
    const addresses = new Set((data as { address: string }[]).map((r) => (chain === "ETH" ? r.address.toLowerCase() : r.address)));
    liveCache.set(chain, { at: Date.now(), addresses });
    return addresses;
  })();
  liveInFlight.set(chain, read);
  try {
    return await read;
  } finally {
    liveInFlight.delete(chain);
  }
}

/** The Alchemy webhooks' signing keys (the delivery route checks each body).
 * `fresh` re-reads them for an unknown webhook — at most every 5 s, so forged
 * deliveries can't turn into a database read each. */
export async function alchemyWebhooks(fresh = false): Promise<AlchemyWebhooks> {
  const age = webhookCache ? Date.now() - webhookCache.at : Infinity;
  if (webhookCache && age < (fresh ? 5_000 : CACHE_MS)) return webhookCache.webhooks;
  webhookCache = { at: Date.now(), webhooks: await loadAlchemyWebhooks() };
  return webhookCache.webhooks;
}

/** Forget the cached lists (after the live set changes). */
export function clearLiveCache(): void {
  liveCache.clear();
  webhookCache = null;
}

export interface DeliveryOutcome {
  transactions: number;
  saved: number;
  skipped: number;
}

/** Each owner's changes saved on its watched address; a broadcast if any
 * line is new. */
async function saveChanges(chain: "SOL" | "ETH", perOwner: Map<string, RawChange[]>, noNativeLegs?: ReadonlySet<string>): Promise<number> {
  const db = serviceDb();
  const { data, error } = await db.from("watched_addresses").select("address, snapshot, tx_activity, last_refresh_at").eq("chain", chain).in("address", [...perOwner.keys()]);
  if (error) throw new Error(`Failed to load addresses: ${error.message}`);
  const now = new Date().toISOString();
  let saved = 0;
  for (const row of data as { address: string; snapshot: WatchSnapshot | null; tx_activity: TxActivity | null; last_refresh_at: string | null }[]) {
    if (!row.snapshot || !row.last_refresh_at) continue; // not read yet: nothing to compare with
    const boundary = row.snapshot.readStartedAt ?? row.last_refresh_at;
    const legs = await identifyLegs(perOwner.get(row.address)!, row.snapshot, readAssetPrices, now, "webhook", noNativeLegs);
    const states = assetStates(row.snapshot);
    const base: Record<string, ActivityBase> = {};
    for (const l of legs) base[l.assetKey] = { qty: states.get(l.assetKey)?.qty ?? 0, kept: states.get(l.assetKey)?.kept ?? false };
    // A position this delivery opens gets its liquidity at entry, asked once
    // (entryLiquidity.ts); the alert reuses the same answer for its supply.
    const stored = row.tx_activity;
    const prevLegs = !stored ? [] : stored.boundary === boundary ? stored.legs : stored.legs.filter((l) => Date.parse(l.at) >= Date.parse(boundary));
    const opening = openingLegs(prevLegs, legs, base);
    const markets = opening.length > 0 ? await entryMarkets(opening) : new Map<string, { liq: number | null; supply: number | null }>();
    for (const l of opening) {
      const liq = markets.get(l.assetKey)?.liq;
      if (liq != null) l.entryLiqUsd = Math.round(liq);
    }
    // Compare-and-set (txActivityStore.ts): two deliveries in the same second
    // no longer overwrite each other. Only new legs count (a duplicate adds none).
    const appended = await appendActivity(chain, row.address, row.last_refresh_at, boundary, legs, base, { live_last_event_at: now });
    if (!appended || appended.added === 0) continue;
    saved += appended.added;
    const known = new Map([...markets].flatMap(([k, m]) => (m.supply !== null ? [[k, m.supply] as [string, number]] : [])));
    // After the response (audit 2026-10-02): the alert's Jupiter call, image
    // and Discord post made a slow delivery look like a failure, and the
    // provider re-sent it — another invocation and credit.
    const before = appended.before;
    const after_ = appended.after;
    const txIds = new Set(legs.map((l) => l.txId));
    after(() => sendWatchAlerts(chain, row.address, before, after_, txIds, known));
  }
  if (saved > 0) after(() => broadcastActivity()); // new lines: open pages fetch theirs (one request), after the response
  return saved;
}

/** One Helius delivery (an array of raw transactions). */
export async function saveDelivery(txs: readonly RawWebhookTx[]): Promise<DeliveryOutcome> {
  const live = await liveAddresses("SOL");
  const perOwner = new Map<string, RawChange[]>();
  const touched = new Map<string, number>(); // every delivered transaction is billed, saved or not
  const trades = new Map<string, number>();
  let skipped = 0;
  for (const tx of txs) {
    if (!tx || typeof tx !== "object" || !tx.transaction) continue; // not a transaction: nothing to read
    const owners = new Set(accountKeys(tx).filter((k) => live.has(k)));
    for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) if (b.owner && live.has(b.owner)) owners.add(b.owner);
    for (const owner of owners) touched.set(owner, (touched.get(owner) ?? 0) + 1);
    for (const owner of owners) {
      const changes = rawTxChanges(tx, owner);
      if (isTrade(changes)) trades.set(owner, (trades.get(owner) ?? 0) + 1);
      if (!worthSaving(changes)) {
        skipped++;
        continue;
      }
      perOwner.set(owner, [...(perOwner.get(owner) ?? []), ...changes]);
    }
  }
  watchForBots("SOL", touched, trades);
  if (perOwner.size === 0) return { transactions: txs.length, saved: 0, skipped };
  return { transactions: txs.length, saved: await saveChanges("SOL", perOwner), skipped };
}

/** The webhook networks deliver internal transfers: no leg is "unclear". */
const ALL_NATIVE_LEGS: ReadonlySet<string> = new Set();

/** One Alchemy delivery (one network's activity, possibly several
 * transactions). Each transaction is judged on its own before any request. */
export async function saveEvmDelivery(delivery: AlchemyDelivery): Promise<DeliveryOutcome> {
  const live = await liveAddresses("ETH");
  const perOwner = new Map<string, RawChange[]>();
  let transactions = 0;
  let skipped = 0;
  const touched = new Map<string, number>();
  const trades = new Map<string, number>();
  for (const [owner, changes] of alchemyChanges(delivery, live)) {
    const byTx = new Map<string, RawChange[]>();
    for (const c of changes) byTx.set(c.txId, [...(byTx.get(c.txId) ?? []), c]);
    touched.set(owner, (touched.get(owner) ?? 0) + byTx.size);
    trades.set(owner, [...byTx.values()].filter(isTrade).length);
    for (const tx of byTx.values()) {
      transactions++;
      if (!worthSaving(tx)) {
        skipped++;
        continue;
      }
      perOwner.set(owner, [...(perOwner.get(owner) ?? []), ...tx]);
    }
  }
  watchForBots("ETH", touched, trades);
  if (perOwner.size === 0) return { transactions, saved: 0, skipped };
  return { transactions, saved: await saveChanges("ETH", perOwner, ALL_NATIVE_LEGS), skipped };
}

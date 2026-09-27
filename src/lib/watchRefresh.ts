import "server-only";
import { serviceDb } from "./supabase";
import { fetchAddressHoldings } from "./lookup";
import { withPriceKeys } from "./adapters/assetKeys";
import { ensureAssetPrices } from "./adapters/assetPrices";
import { mapWithConcurrency } from "./adapters/http";
import { carryForward, keptNote } from "./carryForward";
import { getPriceMap } from "./queries";
import { aggregate, valueHolding } from "./valuation";
import { JOB_STALE_MS } from "./jobStatus";
import { buildSnapshot, previousContracts, snapshotRowToAdapter, type SnapshotRow, type WatchSnapshot } from "./watchSnapshot";
import type { Chain } from "./types";

// Wallet Watch's one refresh path (docs/wallet-watch/PLAN.md): every write of
// a watched address's snapshot goes through refreshWatchedAddress, whether a
// user pressed Refresh or (phase 2) the daily cron ran. It reads the address
// like a wallet sync does — the previous snapshot's tokens passed in, and a
// source that failed keeps its previous rows (carryForward.ts) — so a failed
// read never looks like the address sold something.
//
// Shared tables, written with the service role: one row per address however
// many users watch it. Supabase requests per refresh: 1 read, 1 claim, 1
// write, plus the price-key lookups and pricing a wallet sync also makes.

export interface WatchedKey {
  chain: string;
  address: string;
}

/** How long until an address is due again for the daily cron (phase 2). */
const NEXT_REFRESH_MS = 20 * 60 * 60 * 1000;
/** Addresses read at once: each EVM read already fans out across chains. */
const CONCURRENCY = 2;

/** Creates the shared row for an address the first time anyone watches it. */
export async function ensureWatchedAddress(key: WatchedKey): Promise<void> {
  const { error } = await serviceDb().from("watched_addresses").upsert(key, { onConflict: "chain,address", ignoreDuplicates: true });
  if (error) throw new Error(`Failed to add the address: ${error.message}`);
}

/** Claims the addresses not already being refreshed (compare-and-set, like a
 * wallet sync); returns the ones claimed. */
export async function claimWatchedAddresses(keys: readonly WatchedKey[]): Promise<WatchedKey[]> {
  const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();
  const startedAt = new Date().toISOString();
  const claimed: WatchedKey[] = [];
  for (const k of keys) {
    const { data, error } = await serviceDb()
      .from("watched_addresses")
      .update({ refresh_status: "syncing", refresh_started_at: startedAt })
      .eq("chain", k.chain)
      .eq("address", k.address)
      .or(`refresh_status.neq.syncing,refresh_status.is.null,refresh_started_at.lt.${staleBefore}`)
      .select("chain");
    if (error) throw new Error(`Failed to start refresh: ${error.message}`);
    if (data && data.length > 0) claimed.push(k);
  }
  return claimed;
}

const unitAmount = (raw: string, decimals: number | null) => (decimals === null ? null : Number(raw) / 10 ** decimals);

/** Reads one address and saves its snapshot. Never throws: a failure is
 * recorded in its status and the previous snapshot stays. */
export async function refreshWatchedAddress({ chain, address }: WatchedKey): Promise<void> {
  const db = serviceDb();
  const done = (fields: Record<string, unknown>) => db.from("watched_addresses").update(fields).eq("chain", chain).eq("address", address);
  try {
    const { data: row, error } = await db.from("watched_addresses").select("snapshot").eq("chain", chain).eq("address", address).single();
    if (error) throw new Error(error.message);
    const previous = (row.snapshot as WatchSnapshot | null) ?? null;

    const result = await fetchAddressHoldings(chain as Chain, address, previousContracts(previous));
    const fresh = await withPriceKeys(result.holdings, "auto");
    const previousRows = (previous?.rows ?? []).map(snapshotRowToAdapter);
    const carried = carryForward(fresh, previousRows, result.keep ?? []);
    const keptRows = carried.holdings.slice(fresh.length) as SnapshotRow[];

    // Price what was read first: the snapshot keeps rows by current value.
    await ensureAssetPrices(fresh.map((r) => r.price_key), "watch").catch(() => {});
    const prices = await getPriceMap();
    const valueOf = (r: { ticker: string; qty: number | null; usd_override: number | null; price_key?: string | null }) => {
      const v = valueHolding({ ticker: r.ticker, qty: r.qty, usd_override: r.usd_override, source: "auto", price_key: r.price_key ?? null }, prices);
      return v.kind === "priced" ? v.usd : null;
    };
    const snapshot = buildSnapshot(
      fresh,
      keptRows,
      (result.discovery?.unrecognized ?? []).map((u) => ({ chain: u.chain, contract: u.contract, symbol: u.symbol, amount: unitAmount(u.balanceRaw, u.decimals) })),
      valueOf,
      previous,
    );
    const valued = aggregate(
      snapshot.rows.map((r) => ({ ticker: r.ticker, qty: r.qty ?? null, usd_override: r.usd_override ?? null, source: "auto" as const, price_key: r.price_key ?? null })),
      prices,
    );
    const status = [...result.warnings, keptNote(carried.kept)].filter(Boolean);
    const statusText = status.length === 0 ? "ok" : `partial — ${status.join("; ")}`;
    const now = new Date();
    const { error: saveError } = await done({
      snapshot,
      total_usd: valued.total,
      unpriced_count: valued.unpricedCount,
      last_refresh_at: now.toISOString(),
      last_refresh_status: statusText,
      refresh_status: statusText,
      next_refresh_at: new Date(now.getTime() + NEXT_REFRESH_MS).toISOString(),
    });
    if (saveError) throw new Error(saveError.message);
  } catch (e) {
    const statusText = `error: ${(e as Error).message}`;
    await done({ last_refresh_status: statusText, refresh_status: statusText });
  }
}

export async function refreshWatchedAddresses(keys: readonly WatchedKey[]): Promise<void> {
  await mapWithConcurrency([...keys], CONCURRENCY, refreshWatchedAddress);
}

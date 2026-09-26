import "server-only";
import { serviceDb } from "../supabase";
import { fetchMarketStatsByIds } from "./coingecko";
import { fetchTokenInfo } from "./jupiter";
import { fetchHyperliquidSpotPrices, fetchHyperliquidPerpMarks } from "./hyperliquid";
import { markKeyFor } from "../perpPositions";
import { fetchCoinbaseSpotPrice, fetchCoinbase24hChange } from "../coinbase";
import { mapWithConcurrency } from "./http";
import { planPriceWrites, sourceOf, type FetchedPrice } from "../assetPriceWrites";

// One pricing pass for the whole app (docs/pricing/PLAN.md): every distinct
// price_key held anywhere, plus every watchlist coin, priced once from its
// one source, written to asset_prices (never overwriting a price with null)
// and logged to pricing_runs. The only price table every page reads.

async function allHeldKeys(): Promise<string[]> {
  const db = serviceDb();
  const keys = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("holdings").select("price_key").not("price_key", "is", null).range(from, from + 999);
    if (error) throw new Error(`Failed to read price keys: ${error.message}`);
    for (const r of data as { price_key: string }[]) keys.add(r.price_key);
    if (data.length < 1000) break;
  }
  // Open perp positions' mark prices (live PnL, perpPositions.ts) — only
  // when a position is open, so no call is made otherwise.
  const { data: positions, error: positionsError } = await db.from("holdings").select("chain, ticker").not("position_side", "is", null);
  if (positionsError) throw new Error(`Failed to read open positions: ${positionsError.message}`);
  for (const r of positions as { chain: string | null; ticker: string }[]) {
    const k = markKeyFor(r);
    if (k) keys.add(k);
  }
  const { data: watch, error: watchError } = await db.from("watchlist_items").select("coingecko_id");
  if (watchError) throw new Error(`Failed to read watchlist ids: ${watchError.message}`);
  for (const r of watch as { coingecko_id: string }[]) keys.add(r.coingecko_id);
  return [...keys];
}

/** One source's progress through a pass ("Refresh prices" shows it live). */
export type PricingLane = "coingecko" | "jupiter" | "hyperliquid" | "coinbase";
export type OnLane = (lane: PricingLane, status: "running" | "done" | "error") => void;

/** Prices the given keys (default: every held key + watchlist). Each source
 * is its own lane and fails on its own; `laneErrors` names the ones that
 * failed outright. */
export async function refreshAssetPrices(
  trigger: string,
  only?: string[],
  onLane?: OnLane,
): Promise<{ requested: number; returned: number; missing: string[]; laneErrors: string[] }> {
  const started = Date.now();
  const db = serviceDb();
  const keys = only ?? (await allHeldKeys());
  if (keys.length === 0) return { requested: 0, returned: 0, missing: [], laneErrors: [] };
  const bySource = new Map<string, string[]>();
  for (const k of keys) bySource.set(sourceOf(k), [...(bySource.get(sourceOf(k)) ?? []), k]);

  const fetched = new Map<string, FetchedPrice>();
  const errors = new Map<string, string>();
  const calls: Record<string, number> = {};
  const assets: { price_key: string; symbol: string | null; name: string | null; image_url: string | null; updated_at: string }[] = [];
  const nowIso = () => new Date().toISOString();
  const laneErrors: string[] = [];
  const failAll = (list: string[], e: unknown) => list.forEach((k) => errors.set(k, (e as Error).message));
  // Runs one source's lane, reporting it; a thrown lane marks its keys failed.
  const lane = async (name: PricingLane, list: string[], work: () => Promise<void>) => {
    onLane?.(name, "running");
    try {
      await work();
      onLane?.(name, "done");
    } catch (e) {
      failAll(list, e);
      laneErrors.push(`${name}: ${(e as Error).message}`);
      onLane?.(name, "error");
    }
  };

  const lanes: Promise<void>[] = [];
  const cg = bySource.get("coingecko") ?? [];
  if (cg.length) {
    lanes.push(
      lane("coingecko", cg, async () => {
        calls.coingecko = Math.ceil(cg.length / 250);
        const stats = await fetchMarketStatsByIds(cg);
        for (const [id, s] of stats) {
          fetched.set(id, { usd: s.usd, change_1h: s.change1h, change_24h: s.change24h, change_7d: s.change7d, change_30d: s.change30d, market_cap: s.marketCap, volume_24h: s.volume24h, source: "coingecko" });
          assets.push({ price_key: id, symbol: s.symbol ?? null, name: s.name ?? null, image_url: s.image ?? null, updated_at: nowIso() });
        }
      }),
    );
  }
  const jup = bySource.get("jupiter") ?? [];
  if (jup.length) {
    lanes.push(
      lane("jupiter", jup, async () => {
        calls.jupiter = Math.ceil(jup.length / 100);
        const info = await fetchTokenInfo(jup.map((k) => k.slice(4)));
        for (const k of jup) {
          const t = info.get(k.slice(4));
          if (typeof t?.usdPrice !== "number") continue;
          fetched.set(k, { usd: t.usdPrice, change_24h: t.stats24h?.priceChange ?? null, source: "jupiter" });
          assets.push({ price_key: k, symbol: t.symbol ?? null, name: null, image_url: t.icon ?? null, updated_at: nowIso() });
        }
      }),
    );
  }
  const hl = bySource.get("hyperliquid") ?? [];
  if (hl.length) {
    lanes.push(
      lane("hyperliquid", hl, async () => {
        // Spot tokens ("hl:") and perp marks ("hlperp:") are one call each,
        // made only for the kinds actually requested.
        const spotKeys = hl.filter((k) => k.startsWith("hl:"));
        const perpKeys = hl.filter((k) => k.startsWith("hlperp:"));
        calls.hyperliquid = (spotKeys.length > 0 ? 1 : 0) + (perpKeys.length > 0 ? 1 : 0);
        const [spot, perps] = await Promise.all([
          spotKeys.length > 0 ? fetchHyperliquidSpotPrices() : new Map<string, { usd: number; change24h: number | null }>(),
          perpKeys.length > 0 ? fetchHyperliquidPerpMarks() : new Map<string, { usd: number; change24h: number | null }>(),
        ]);
        for (const k of spotKeys) {
          const p = spot.get(k.slice(3));
          if (p) fetched.set(k, { usd: p.usd, change_24h: p.change24h, source: "hyperliquid" });
          assets.push({ price_key: k, symbol: k.slice(3), name: null, image_url: null, updated_at: nowIso() });
        }
        for (const k of perpKeys) {
          const p = perps.get(k.slice("hlperp:".length));
          if (p) fetched.set(k, { usd: p.usd, change_24h: p.change24h, source: "hyperliquid" });
          assets.push({ price_key: k, symbol: `${k.slice("hlperp:".length)}-PERP`, name: null, image_url: null, updated_at: nowIso() });
        }
      }),
    );
  }
  const cb = bySource.get("coinbase") ?? [];
  if (cb.length) {
    lanes.push(
      lane("coinbase", cb, async () => {
        calls.coinbase = cb.length * 2;
        await mapWithConcurrency(cb, 4, async (k) => {
          const ticker = k.slice(9);
          try {
            const [usd, change] = await Promise.all([fetchCoinbaseSpotPrice(ticker), fetchCoinbase24hChange(ticker).catch(() => null)]);
            fetched.set(k, { usd: Number(usd), change_24h: change, source: "coinbase" });
            assets.push({ price_key: k, symbol: ticker, name: null, image_url: null, updated_at: nowIso() });
          } catch (e) {
            errors.set(k, (e as Error).message);
          }
        });
      }),
    );
  }
  await Promise.all(lanes);
  // Fiat cash: the US dollar is $1 by definition (not a market price). Other
  // currencies stay unpriced until there's a source for them.
  for (const k of bySource.get("fiat") ?? []) {
    if (k === "fiat:USD") fetched.set(k, { usd: 1, change_24h: 0, source: "fiat" });
  }

  // missing_since must keep the first time a key went missing.
  const missingSince = new Map<string, string | null>();
  for (let i = 0; i < keys.length; i += 500) {
    const { data } = await db.from("asset_prices").select("price_key, missing_since").in("price_key", keys.slice(i, i + 500));
    for (const r of (data ?? []) as { price_key: string; missing_since: string | null }[]) missingSince.set(r.price_key, r.missing_since);
  }
  const writes = planPriceWrites(keys, fetched, errors, missingSince, nowIso());
  // Found and missing rows carry different columns; an upsert only touches
  // the columns it's given, so a missing key's stored usd is left alone.
  const found = writes.filter((w) => "usd" in w);
  const missed = writes.filter((w) => !("usd" in w));
  for (const batch of [found, missed]) {
    for (let i = 0; i < batch.length; i += 500) {
      const { error } = await db.from("asset_prices").upsert(batch.slice(i, i + 500), { onConflict: "price_key" });
      if (error) throw new Error(`Failed to save asset prices: ${error.message}`);
    }
  }
  // Display info (symbol / name / logo) from each key's own source.
  const withInfo = assets.filter((a) => a.symbol || a.name || a.image_url);
  for (let i = 0; i < withInfo.length; i += 500) {
    await db.from("assets").upsert(withInfo.slice(i, i + 500), { onConflict: "price_key" });
  }

  const missing = missed.map((w) => w.price_key);
  await db.from("pricing_runs").insert({
    trigger,
    duration_ms: Date.now() - started,
    requested: keys.length,
    returned: found.length,
    missing: missing.map((k) => ({ key: k, error: errors.get(k) ?? "not returned" })),
    calls,
  });
  return { requested: keys.length, returned: found.length, missing, laneErrors };
}

/** Prices just the keys that have no price yet or one older than maxAgeMs —
 * after a sync (its own coins) and for an address lookup. A Sync all prices
 * every held coin once up front (primeSyncPricesAction), so each wallet's
 * call here usually finds everything fresh; 15 minutes covers a whole Sync
 * all (~3 min). Only a coin nobody has priced yet costs a call. */
export async function ensureAssetPrices(keys: (string | null | undefined)[], trigger: string, maxAgeMs = 15 * 60 * 1000): Promise<void> {
  const distinct = [...new Set(keys.filter((k): k is string => !!k))];
  if (distinct.length === 0) return;
  const fresh = new Set<string>();
  for (let i = 0; i < distinct.length; i += 500) {
    const { data } = await serviceDb()
      .from("asset_prices")
      .select("price_key, usd, updated_at")
      .in("price_key", distinct.slice(i, i + 500))
      .gte("updated_at", new Date(Date.now() - maxAgeMs).toISOString());
    for (const r of (data ?? []) as { price_key: string; usd: unknown }[]) if (r.usd !== null) fresh.add(r.price_key);
  }
  const stale = distinct.filter((k) => !fresh.has(k));
  if (stale.length > 0) await refreshAssetPrices(trigger, stale);
}

/** A full pass when the newest price is older than maxAgeMs — the daily
 * snapshot's guard against recording stale prices into history. */
export async function refreshAssetPricesIfOlderThan(maxAgeMs: number, trigger: string): Promise<string> {
  const { data } = await serviceDb().from("asset_prices").select("updated_at").order("updated_at", { ascending: false, nullsFirst: false }).limit(1);
  const newest = data?.[0]?.updated_at ? Date.parse(data[0].updated_at as string) : 0;
  if (Date.now() - newest < maxAgeMs) return "fresh";
  const r = await refreshAssetPrices(trigger);
  return `priced ${r.returned}/${r.requested}`;
}

/** Each key's stored 24h trading volume (asset_prices.volume_24h; null when
 * its source reports none) — the tradability signal (receiptDedupe.ts). */
export async function readAssetVolumes(keys: (string | null | undefined)[]): Promise<Map<string, number | null>> {
  const distinct = [...new Set(keys.filter((k): k is string => !!k))];
  const out = new Map<string, number | null>();
  for (let i = 0; i < distinct.length; i += 500) {
    const { data, error } = await serviceDb().from("asset_prices").select("price_key, volume_24h").in("price_key", distinct.slice(i, i + 500));
    if (error) throw new Error(`Failed to read trading volumes: ${error.message}`);
    for (const r of data as { price_key: string; volume_24h: number | string | null }[]) out.set(r.price_key, r.volume_24h === null ? null : Number(r.volume_24h));
  }
  return out;
}

/** The stored price of each key that has one (asset_prices.usd). */
export async function readAssetPrices(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < keys.length; i += 500) {
    const { data, error } = await serviceDb().from("asset_prices").select("price_key, usd").in("price_key", keys.slice(i, i + 500)).not("usd", "is", null);
    if (error) throw new Error(`Failed to read asset prices: ${error.message}`);
    for (const r of data as { price_key: string; usd: number | string }[]) out.set(r.price_key, Number(r.usd));
  }
  return out;
}

/** Today's (UTC) close for every asset priced in the last 24 hours, into
 * asset_price_daily — the daily snapshot's record of prices, which is the
 * price history Analytics reads (priceHistory.ts). An asset whose price is
 * older than a day gets no close for today rather than a stale one. */
export async function recordDailyCloses(): Promise<string> {
  const db = serviceDb();
  const day = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows: { price_key: string; day: string; usd: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("asset_prices")
      .select("price_key, usd")
      .not("usd", "is", null)
      .gte("updated_at", since)
      .order("price_key")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to read asset prices: ${error.message}`);
    for (const r of data as { price_key: string; usd: number | string }[]) rows.push({ price_key: r.price_key, day, usd: Number(r.usd) });
    if (data.length < 1000) break;
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("asset_price_daily").upsert(rows.slice(i, i + 500), { onConflict: "price_key,day" });
    if (error) throw new Error(`Failed to save daily closes: ${error.message}`);
  }
  return `${rows.length} closes for ${day}`;
}

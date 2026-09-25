import "server-only";
import { serviceDb } from "../supabase";
import { fetchMarketStatsByIds } from "./coingecko";
import { fetchTokenInfo } from "./jupiter";
import { fetchHyperliquidSpotPrices } from "./hyperliquid";
import { fetchCoinbaseSpotPrice, fetchCoinbase24hChange } from "../coinbase";
import { mapWithConcurrency } from "./http";
import { planPriceWrites, sourceOf, type FetchedPrice } from "../assetPriceWrites";

// One pricing pass for the whole app (docs/pricing/PLAN.md): every distinct
// price_key held anywhere, plus every watchlist coin, priced once from its
// one source, written to asset_prices (never overwriting a price with null)
// and logged to pricing_runs. Phase 1: runs alongside today's pricing; no
// page reads asset_prices yet.

async function allHeldKeys(): Promise<string[]> {
  const db = serviceDb();
  const keys = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("holdings").select("price_key").not("price_key", "is", null).range(from, from + 999);
    if (error) throw new Error(`Failed to read price keys: ${error.message}`);
    for (const r of data as { price_key: string }[]) keys.add(r.price_key);
    if (data.length < 1000) break;
  }
  const { data: watch, error: watchError } = await db.from("watchlist_items").select("coingecko_id");
  if (watchError) throw new Error(`Failed to read watchlist ids: ${watchError.message}`);
  for (const r of watch as { coingecko_id: string }[]) keys.add(r.coingecko_id);
  return [...keys];
}

/** Prices the given keys (default: every held key + watchlist). */
export async function refreshAssetPrices(
  trigger: string,
  only?: string[],
): Promise<{ requested: number; returned: number; missing: string[] }> {
  const started = Date.now();
  const db = serviceDb();
  const keys = only ?? (await allHeldKeys());
  if (keys.length === 0) return { requested: 0, returned: 0, missing: [] };
  const bySource = new Map<string, string[]>();
  for (const k of keys) bySource.set(sourceOf(k), [...(bySource.get(sourceOf(k)) ?? []), k]);

  const fetched = new Map<string, FetchedPrice>();
  const errors = new Map<string, string>();
  const calls: Record<string, number> = {};
  const assets: { price_key: string; symbol: string | null; name: string | null; image_url: string | null; updated_at: string }[] = [];
  const nowIso = () => new Date().toISOString();
  const failAll = (list: string[], e: unknown) => list.forEach((k) => errors.set(k, (e as Error).message));

  const lanes: Promise<void>[] = [];
  const cg = bySource.get("coingecko") ?? [];
  if (cg.length) {
    lanes.push(
      (async () => {
        calls.coingecko = Math.ceil(cg.length / 250);
        try {
          const stats = await fetchMarketStatsByIds(cg);
          for (const [id, s] of stats) {
            fetched.set(id, { usd: s.usd, change_1h: s.change1h, change_24h: s.change24h, change_7d: s.change7d, change_30d: s.change30d, market_cap: s.marketCap, source: "coingecko" });
            assets.push({ price_key: id, symbol: s.symbol ?? null, name: s.name ?? null, image_url: s.image ?? null, updated_at: nowIso() });
          }
        } catch (e) {
          failAll(cg, e);
        }
      })(),
    );
  }
  const jup = bySource.get("jupiter") ?? [];
  if (jup.length) {
    lanes.push(
      (async () => {
        calls.jupiter = Math.ceil(jup.length / 100);
        try {
          const info = await fetchTokenInfo(jup.map((k) => k.slice(4)));
          for (const k of jup) {
            const t = info.get(k.slice(4));
            if (typeof t?.usdPrice !== "number") continue;
            fetched.set(k, { usd: t.usdPrice, change_24h: t.stats24h?.priceChange ?? null, source: "jupiter" });
            assets.push({ price_key: k, symbol: t.symbol ?? null, name: null, image_url: t.icon ?? null, updated_at: nowIso() });
          }
        } catch (e) {
          failAll(jup, e);
        }
      })(),
    );
  }
  const hl = bySource.get("hyperliquid") ?? [];
  if (hl.length) {
    lanes.push(
      (async () => {
        calls.hyperliquid = 1;
        try {
          const spot = await fetchHyperliquidSpotPrices();
          for (const k of hl) {
            const p = spot.get(k.slice(3));
            if (p) fetched.set(k, { usd: p.usd, change_24h: p.change24h, source: "hyperliquid" });
            assets.push({ price_key: k, symbol: k.slice(3), name: null, image_url: null, updated_at: nowIso() });
          }
        } catch (e) {
          failAll(hl, e);
        }
      })(),
    );
  }
  const cb = bySource.get("coinbase") ?? [];
  if (cb.length) {
    lanes.push(
      (async () => {
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
      })(),
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
  return { requested: keys.length, returned: found.length, missing };
}

/** Prices just the keys that have no price yet or one older than maxAgeMs —
 * after a sync (its own coins) and for an address lookup. A key another
 * wallet's sync priced a minute ago isn't asked again, so a Sync all prices
 * each coin about once. */
export async function ensureAssetPrices(keys: (string | null | undefined)[], trigger: string, maxAgeMs = 5 * 60 * 1000): Promise<void> {
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

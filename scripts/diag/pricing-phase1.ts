// Pricing phase 1 (docs/pricing/PLAN.md). Three modes:
//
//   diff      (default, read-only) every active holding's current value vs
//             qty × asset_prices[price_key], each difference classified.
//   seed      upserts exchange_assets: Coinbase from exchange_asset_registry;
//             Kraken/Gemini/MEXC from the same catalog marked
//             'coinbase-catalog' (what they effectively use today — review);
//             Hyperliquid/Polymarket stablecoins by their CoinGecko ids.
//   backfill  sets holdings.price_key on every existing row (syncs keep it
//             current afterwards). Upserts only (id, wallet_id, ticker,
//             source, price_key) — nothing else on a row changes.
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/diag/pricing-phase1.ts [diff|seed|backfill]
//
// No CoinGecko calls in any mode (prices come from asset_prices, filled by
// Refresh prices).
process.loadEnvFile(`${__dirname}/../../.env.local`);

type Row = {
  id: string;
  wallet_id: string;
  ticker: string;
  chain: string | null;
  contract: string | null;
  source: string;
  category: string;
  coingecko_id: string | null;
  protocol_section: string | null;
  qty: number | string | null;
  usd_override: number | string | null;
  price_key: string | null;
};

async function main() {
  const mode = process.argv[2] ?? "diff";
  const { serviceDb } = await import("../../src/lib/supabase");
  const db = serviceDb();

  if (mode === "seed") {
    const { data: reg } = await db.from("exchange_asset_registry").select("ticker, coingecko_id");
    const now = new Date().toISOString();
    const rows = (reg as { ticker: string; coingecko_id: string }[]).flatMap((r) => [
      { exchange: "coinbase", ticker: r.ticker.toUpperCase(), price_key: r.coingecko_id, mapping_source: "coinbase-registry", updated_at: now },
      ...["kraken", "gemini", "mexc"].map((exchange) => ({ exchange, ticker: r.ticker.toUpperCase(), price_key: r.coingecko_id, mapping_source: "coinbase-catalog", updated_at: now })),
    ]);
    rows.push(
      { exchange: "hyperliquid", ticker: "USDC", price_key: "usd-coin", mapping_source: "manual", updated_at: now },
      { exchange: "hyperliquid", ticker: "USDT0", price_key: "usdt0", mapping_source: "manual", updated_at: now },
      { exchange: "hyperliquid", ticker: "USDE", price_key: "ethena-usde", mapping_source: "manual", updated_at: now },
      { exchange: "polymarket", ticker: "PUSD", price_key: "polymarket-usd", mapping_source: "manual", updated_at: now },
    );
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("exchange_assets").upsert(rows.slice(i, i + 500), { onConflict: "exchange,ticker" });
      if (error) throw new Error(error.message);
    }
    console.log(`seeded ${rows.length} exchange_assets rows`);
    return;
  }

  let rows: Row[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db
      .from("holdings")
      .select("id, wallet_id, ticker, chain, contract, source, category, coingecko_id, protocol_section, qty, usd_override, price_key, wallets!inner(active)")
      .eq("wallets.active", true)
      .range(f, f + 999);
    if (error) throw new Error(error.message);
    rows = rows.concat(data as unknown as Row[]);
    if (data.length < 1000) break;
  }

  if (mode === "backfill") {
    const { withPriceKeys } = await import("../../src/lib/adapters/assetKeys");
    const bySource = new Map<string, Row[]>();
    for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
    let set = 0;
    for (const [source, list] of bySource) {
      const keyed = await withPriceKeys(list, source);
      const updates = keyed.map((r) => ({ id: r.id, wallet_id: r.wallet_id, ticker: r.ticker, source: r.source, price_key: r.price_key }));
      for (let i = 0; i < updates.length; i += 500) {
        const { error } = await db.from("holdings").upsert(updates.slice(i, i + 500), { onConflict: "id" });
        if (error) throw new Error(error.message);
      }
      set += keyed.filter((r) => r.price_key).length;
      console.log(`${source}: ${keyed.length} rows, ${keyed.filter((r) => r.price_key).length} keyed`);
    }
    console.log(`backfill done: ${set}/${rows.length} rows have a price key`);
    return;
  }

  // diff (read-only)
  const { valueHolding } = await import("../../src/lib/valuation");
  const { isPositionValue } = await import("../../src/lib/assetIdentity");
  const { data: priceRows } = await db.from("prices").select("ticker, usd");
  const priceMap = Object.fromEntries((priceRows as { ticker: string; usd: number }[]).map((p) => [p.ticker, p.usd]));
  const keys = [...new Set(rows.map((r) => r.price_key).filter(Boolean))] as string[];
  const assetPrice = new Map<string, { usd: number | null; source: string | null; updated_at: string | null; missing_since: string | null }>();
  for (let i = 0; i < keys.length; i += 500) {
    const { data } = await db.from("asset_prices").select("price_key, usd, source, updated_at, missing_since").in("price_key", keys.slice(i, i + 500));
    for (const p of (data ?? []) as { price_key: string; usd: number | null; source: string; updated_at: string; missing_since: string | null }[]) assetPrice.set(p.price_key, p);
  }

  type Cls = "same" | "position" | "no key" | "no price yet" | "differs" | "newly priced" | "newly unpriced";
  const out: { cls: Cls; r: Row; oldUsd: number | null; newUsd: number | null; note: string }[] = [];
  for (const r of rows) {
    const old = valueHolding({ ticker: r.ticker, qty: r.qty, usd_override: r.usd_override, source: r.source as never }, priceMap);
    const oldUsd = old.kind === "priced" ? old.usd : null;
    const qty = Number(r.qty);
    if (isPositionValue(r)) {
      out.push({ cls: "position", r, oldUsd, newUsd: oldUsd, note: "stored position value" });
      continue;
    }
    if (!r.price_key) {
      out.push({ cls: "no key", r, oldUsd, newUsd: null, note: `${r.source} ${r.chain ?? "-"} ${r.contract ?? "native"}` });
      continue;
    }
    const p = assetPrice.get(r.price_key);
    if (!p || p.usd === null) {
      out.push({ cls: "no price yet", r, oldUsd, newUsd: null, note: r.price_key });
      continue;
    }
    const newUsd = Number.isFinite(qty) ? qty * Number(p.usd) : null;
    const cls: Cls =
      oldUsd === null ? "newly priced" : newUsd === null ? "newly unpriced" : Math.abs(newUsd - oldUsd) <= Math.max(0.01, Math.abs(oldUsd) * 0.01) ? "same" : "differs";
    out.push({ cls, r, oldUsd, newUsd, note: `${r.price_key} (${p.source}${p.missing_since ? ", missing since " + p.missing_since.slice(0, 16) : ""})` });
  }

  const sum = (xs: typeof out, f: (x: (typeof out)[number]) => number | null) => xs.reduce((s, x) => s + (f(x) ?? 0), 0);
  console.log(`active holdings: ${rows.length}`);
  console.log(`total now $${sum(out, (x) => x.oldUsd).toFixed(2)}  →  one-price total $${sum(out, (x) => x.newUsd).toFixed(2)}`);
  for (const cls of ["same", "position", "differs", "newly priced", "newly unpriced", "no price yet", "no key"] as Cls[]) {
    const xs = out.filter((x) => x.cls === cls);
    console.log(`\n== ${cls}: ${xs.length} rows, now $${sum(xs, (x) => x.oldUsd).toFixed(2)} → $${sum(xs, (x) => x.newUsd).toFixed(2)}`);
    if (cls === "same" || cls === "position") continue;
    const shown = [...xs].sort((a, b) => Math.abs((b.newUsd ?? 0) - (b.oldUsd ?? 0)) - Math.abs((a.newUsd ?? 0) - (a.oldUsd ?? 0))).slice(0, 25);
    for (const x of shown) {
      const unitOld = x.oldUsd !== null && Number(x.r.qty) ? x.oldUsd / Number(x.r.qty) : null;
      const unitNew = x.newUsd !== null && Number(x.r.qty) ? x.newUsd / Number(x.r.qty) : null;
      console.log(`  ${x.r.ticker.padEnd(10)} ${String(x.r.chain).padEnd(12)} $${(x.oldUsd ?? NaN).toFixed(2).padStart(10)} → $${(x.newUsd ?? NaN).toFixed(2).padStart(10)}  unit ${unitOld?.toPrecision(4) ?? "-"} → ${unitNew?.toPrecision(4) ?? "-"}  ${x.note}`);
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};

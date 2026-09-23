// Read-only. Rated assets (in a live run) that CoinGecko tags Layer 1 or
// Layer 2 — a review list, NOT an exclusion rule. Why: NEAR got rated
// because DefiLlama files NEAR Intents/Perps under the parent "NEAR
// Protocol", whose gecko_id is the L1 token, so the category-based
// out_of_scope gate never saw it. config.scopeOverrides fixes the cases we
// notice; this surfaces the next one instead of finding it by accident.
//
//   node scripts/diag/screener-l1l2-rated.mjs            # latest live run
//   node scripts/diag/screener-l1l2-rated.mjs <run_id>
//
// Cost: CoinGecko category member lists (/coins/markets?category=...), 250
// per page by market cap, stopping once a page drops below the $10M mcap
// floor (nothing below it can be rated) — a handful of calls, instead of one
// rate-limited /coins/{id} call per rated asset.
import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(new URL("../../.env.local", import.meta.url).pathname);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "cryptoport" } });

const CATEGORIES = ["layer-1", "layer-2"];
const MCAP_FLOOR = 10_000_000; // config.gates.mcapFloorUsd
const KEYS = [process.env.COINGECKO_API_KEY, process.env.COINGECKO_API_KEY_BACKUP].filter(Boolean);

async function cg(url) {
  for (const key of KEYS) {
    const res = await fetch(url, { headers: { "x-cg-demo-api-key": key }, cache: "no-store" });
    const body = await res.json();
    if (body?.status?.error_code === 10006) continue; // monthly cap on this key -> next key
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  }
  throw new Error("every CoinGecko key is at its monthly cap");
}

let runId = process.argv[2];
if (!runId) {
  const { data } = await db.from("screener_runs").select("id").eq("kind", "live").eq("status", "ok").order("started_at", { ascending: false }).limit(1).single();
  runId = data.id;
}
const { data: rated, error } = await db
  .from("screener_asset_metrics")
  .select("sector_bucket, rev_ann, screener_assets(gecko_id, name, ticker, sector)")
  .eq("run_id", runId)
  .eq("rated", true);
if (error) throw error;

const tagged = new Map(); // gecko_id -> [category]
let calls = 0;
for (const category of CATEGORIES) {
  for (let page = 1; ; page++) {
    const rows = await cg(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${category}&order=market_cap_desc&per_page=250&page=${page}`);
    calls++;
    for (const r of rows) tagged.set(r.id, [...(tagged.get(r.id) ?? []), category]);
    const last = rows.at(-1)?.market_cap;
    if (rows.length < 250 || last == null || last < MCAP_FLOOR) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

console.log(`run ${runId}: ${rated.length} rated; ${calls} CoinGecko calls; ${tagged.size} coins tagged ${CATEGORIES.join("/")} down to the $10M floor`);
const hits = rated.filter((r) => tagged.has(r.screener_assets.gecko_id));
for (const r of hits.sort((x, y) => (y.rev_ann ?? 0) - (x.rev_ann ?? 0))) {
  const a = r.screener_assets;
  console.log(
    `${a.ticker.toUpperCase().padEnd(8)} ${a.gecko_id.padEnd(28)} ${tagged.get(a.gecko_id).join("+").padEnd(16)} ` +
      `DefiLlama category: ${String(a.sector).padEnd(16)} bucket: ${r.sector_bucket.padEnd(22)} rev_ann $${((r.rev_ann ?? 0) / 1e6).toFixed(1)}M`,
  );
}
console.log(`${hits.length} rated asset(s) carry an L1/L2 tag — review each; this list excludes nothing on its own.`);

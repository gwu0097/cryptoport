// Read-only. Phase 4a survivorship bound per window: dead-token protocols (open no_coingecko_market_data intervals:
// a resolved gecko_id CoinGecko has no market data for today) whose trailing-30d DefiLlama revenue (complete days)
// cleared the $1M annualized floor on at least one of the window's formation dates. Lower bound: protocols
// DefiLlama no longer lists are invisible. Needs coverage_<w>.json from scripts/screener-backtest-panel.ts.
//
//   node scripts/diag/screener-survivorship-bound.mjs     (~180 DefiLlama calls at 1s; zero CoinGecko)
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
process.loadEnvFile(new URL("../../.env.local", import.meta.url).pathname);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "cryptoport" } });
const dir = `${process.env.SCREENER_ARCHIVE_DIR ?? `${homedir()}/cryptoport-archive/screener`}/backtest`;
const { data: open } = await db.from("screener_unmatched").select("identifier, reason").eq("kind", "no_coingecko_market_data").is("resolved_run_id", null);
const floor30 = (1_000_000 * 30) / 365;
const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const windows = Object.fromEntries(["1y", "2y", "3y"].map((w) => [w, JSON.parse(readFileSync(`${dir}/coverage_${w}.json`, "utf8"))]));
const hits = { "1y": [], "2y": [], "3y": [] };
let calls = 0;
for (const u of open) {
  const slugs = (u.reason?.match(/slug\(s\): ([^)]*)\)/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const daily = new Map();
  for (const slug of slugs) {
    await new Promise((r) => setTimeout(r, 1000));
    calls++;
    const res = await fetch(`https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}?dataType=dailyRevenue`, { cache: "no-store" });
    if (!res.ok) continue;
    for (const [t, v] of (await res.json()).totalDataChart ?? []) {
      const d = new Date(t * 1000).toISOString().slice(0, 10);
      daily.set(d, (daily.get(d) ?? 0) + v);
    }
  }
  const trailing = (D) => { let s = 0; for (let k = 0; k < 30; k++) { const v = daily.get(shift(D, -k)); if (v === undefined) return null; s += v; } return s; };
  for (const [w, c] of Object.entries(windows)) {
    const cleared = c.formation_dates_30d.filter((D) => (trailing(D) ?? 0) >= floor30);
    if (cleared.length) hits[w].push({ gecko_id: u.identifier, slugs, dates_cleared: cleared.length, first: cleared[0], last: cleared.at(-1) });
  }
}
const summary = Object.fromEntries(
  Object.entries(windows).map(([w, c]) => {
    const pop = c.per_date.reduce((a, p) => a + p.rated, 0);
    const miss = hits[w].reduce((a, h) => a + h.dates_cleared, 0);
    return [w, { protocols: hits[w].length, missing_asset_periods: miss, tested_asset_periods: pop, share_absent: +(miss / (pop + miss)).toFixed(4) }];
  }),
);
const out = { definition: "see header comment", checked: open.length, calls, summary, hits };
writeFileSync(`${dir}/survivorship_by_window.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ checked: out.checked, calls, summary }, null, 1));

// Read-only: every active user's portfolio total and unpriced count, computed
// exactly like the daily snapshot (capturePortfolioSnapshots: getPriceMap +
// aggregate). For checking that a pricing refactor leaves totals unchanged.
//
//   save:    <tsx> scripts/diag/portfolio-totals.ts save <file.json>
//   compare: <tsx> scripts/diag/portfolio-totals.ts compare <file.json>
//
// Run with a cached tsx and NODE_OPTIONS="--conditions=react-server" (see
// CLAUDE.md, "Diagnostic scripts").
import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

type Totals = Record<
  string,
  { total: number; unpriced: number; holdings: number }
>;

async function totals(): Promise<Totals> {
  const { serviceDb } = await import("../../src/lib/supabase");
  const { aggregate } = await import("../../src/lib/valuation");
  // Same read as queries.ts's getPriceMap (importing queries.ts outside Next
  // pulls in next/navigation).
  const prices: Record<string, number | string | null> = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await serviceDb().from("asset_prices").select("price_key, usd").order("price_key").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data as { price_key: string; usd: number | string | null }[]) prices[r.price_key] = r.usd;
    if (data.length < 1000) break;
  }
  const { data, error } = await serviceDb().from("wallets").select("user_id, holdings(*)").eq("active", true);
  if (error) throw new Error(error.message);
  const byUser = new Map<string, unknown[]>();
  for (const w of data as { user_id: string; holdings: unknown[] }[])
    byUser.set(w.user_id, [...(byUser.get(w.user_id) ?? []), ...w.holdings]);
  const out: Totals = {};
  for (const [user, holdings] of byUser) {
    const { total, unpricedCount } = aggregate(holdings as never, prices);
    out[user] = { total, unpriced: unpricedCount, holdings: holdings.length };
  }
  return out;
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!file || (mode !== "save" && mode !== "compare")) {
    console.error("usage: portfolio-totals.ts save|compare <file.json>");
    process.exit(1);
  }
  const now = await totals();
  if (mode === "save") {
    writeFileSync(file, JSON.stringify(now, null, 2));
    for (const [u, t] of Object.entries(now))
      console.log(u.slice(0, 8), t.total.toFixed(2), `unpriced ${t.unpriced}`);
  } else {
    const before = JSON.parse(readFileSync(file, "utf8")) as Totals;
    for (const u of new Set([...Object.keys(before), ...Object.keys(now)])) {
      const a = before[u];
      const b = now[u];
      const d = (b?.total ?? 0) - (a?.total ?? 0);
      console.log(
        u.slice(0, 8),
        a?.total.toFixed(2) ?? "-",
        "->",
        b?.total.toFixed(2) ?? "-",
        `(${d >= 0 ? "+" : ""}${d.toFixed(2)})`,
        `unpriced ${a?.unpriced ?? "-"} -> ${b?.unpriced ?? "-"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
